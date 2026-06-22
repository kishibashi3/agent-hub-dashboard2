import { getDb, tenantCond } from '../db.js';
import { esc, escAttr, fmtRelative } from '../utils.js';
import { htmlShell, renderNav } from '../layout.js';
import {
  PPD_THREAD_THRESHOLD, PPD_CRITICAL_THRESHOLD, PPD_SEVERE_THRESHOLD,
  CDS_HIGH_SIGNALS, CDS_LOW_SIGNALS, CDS_WARNING_THRESHOLD, CDS_DANGER_THRESHOLD,
  META_SIGNALS, MOR_WARNING, MOR_DANGER,
  ESCALATION_SIGNALS, GO_RESPONSE_SIGNALS, NON_GO_RESPONSE_SIGNALS,
} from '../constants.js';

// ── renderHealth ───────────────────────────────────────────────
export function renderHealth(prefix: string, totalLinks: number): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;

  interface PpdThread { rootId: string; size: number; firstTs: string | null; lastTs: string | null; sender: string; recipient: string; severity: string; }
  interface EqsEscalation { id: string; sender: string; recipient: string; body: string; ts: string; response: string; }

  let ppdThreads: PpdThread[] = [];
  let eqsEscalations: EqsEscalation[] = [];
  let eqsTotal = 0; let eqsGo = 0; let eqsNonGo = 0; let eqsUnanswered = 0;
  let cdsScore = 0; let cdsHigh = 0; let cdsLow = 0; let cdsTotalMsgs = 0;
  let morScore = 0; let morMeta = 0; let morTotalMsgs = 0;
  let morMessages: { body: string; ts: string }[] = [];

  try {
    const tc = tenantCond();
    const tWhere = tc.cond ? 'WHERE ' + tc.cond.slice(4) : '';
    const tAnd = tc.cond;
    const tParams = tc.params;

    totalMsgs = (db.prepare(`SELECT COUNT(*) FROM messages ${tWhere}`).pluck().get(...tParams) as number) ?? 0;
    totalAgents = (db.prepare(`SELECT COUNT(DISTINCT name) FROM participants ${tWhere}`).pluck().get(...tParams) as number) ?? 0;

    // PPD
    const ppdRows = db.prepare(
      `SELECT mc.root_message_id, COUNT(*) AS thread_size,
              MIN(m.created_at) AS first_ts, MAX(m.created_at) AS last_ts
       FROM message_causes mc
       JOIN messages m ON m.id=mc.message_id ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
       WHERE mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
       GROUP BY mc.root_message_id
       HAVING thread_size >= ?
       ORDER BY thread_size DESC
       LIMIT 50`
    ).all(...(tAnd ? [...tParams, ...tParams] : []), PPD_THREAD_THRESHOLD) as { root_message_id: string; thread_size: number; first_ts: string | null; last_ts: string | null }[];

    for (const row of ppdRows) {
      const rootMsg = db.prepare(`SELECT sender, recipient FROM messages WHERE id = ? ${tAnd} LIMIT 1`).get(row.root_message_id, ...tParams) as { sender: string; recipient: string } | undefined;
      const severity = row.thread_size >= PPD_SEVERE_THRESHOLD ? 'severe' : row.thread_size >= PPD_CRITICAL_THRESHOLD ? 'critical' : 'warning';
      ppdThreads.push({
        rootId: row.root_message_id,
        size: row.thread_size,
        firstTs: row.first_ts,
        lastTs: row.last_ts,
        sender: rootMsg?.sender ?? '?',
        recipient: rootMsg?.recipient ?? '?',
        severity,
      });
    }

    // EQS — scan last 5000 messages
    const allMsgs = db.prepare(
      `SELECT id, sender, recipient, body, created_at FROM messages ${tWhere} ORDER BY created_at DESC LIMIT 5000`
    ).all(...tParams) as { id: string; sender: string; recipient: string; body: string; created_at: string }[];

    const escalationMsgs = allMsgs.filter(m => ESCALATION_SIGNALS.some(s => m.body.includes(s)));
    eqsTotal = escalationMsgs.length;

    for (const esc_msg of escalationMsgs.slice(0, 100)) {
      const mcRow = db.prepare(`SELECT root_message_id FROM message_causes WHERE message_id=? AND position=0 ${tAnd} LIMIT 1`).get(esc_msg.id, ...tParams) as { root_message_id: string } | undefined;
      let response = 'unanswered';
      if (mcRow) {
        const threadMsgs = db.prepare(
          `SELECT m.body, m.created_at FROM messages m
           JOIN message_causes mc ON mc.message_id=m.id AND mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
           WHERE mc.root_message_id=? AND m.created_at > ? ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
           ORDER BY m.created_at ASC LIMIT 10`
        ).all(...(tAnd ? tParams : []), mcRow.root_message_id, esc_msg.created_at, ...(tAnd ? tParams : [])) as { body: string }[];
        for (const tm of threadMsgs) {
          if (GO_RESPONSE_SIGNALS.some(s => tm.body.includes(s))) { response = 'go'; break; }
          if (NON_GO_RESPONSE_SIGNALS.some(s => tm.body.includes(s))) { response = 'non-go'; break; }
        }
      }
      if (response === 'go') eqsGo++;
      else if (response === 'non-go') eqsNonGo++;
      else eqsUnanswered++;
      eqsEscalations.push({ id: esc_msg.id, sender: esc_msg.sender, recipient: esc_msg.recipient, body: esc_msg.body.slice(0,80), ts: esc_msg.created_at, response });
    }

    // CDS
    const cdsMsgs = db.prepare(`SELECT body FROM messages ${tWhere} ORDER BY created_at DESC LIMIT 2000`).all(...tParams) as { body: string }[];
    cdsTotalMsgs = cdsMsgs.length;
    for (const m of cdsMsgs) {
      if (CDS_HIGH_SIGNALS.some(s => m.body.includes(s))) cdsHigh++;
      else if (CDS_LOW_SIGNALS.some(s => m.body.includes(s))) cdsLow++;
    }
    cdsScore = cdsTotalMsgs > 0 ? Math.round((cdsHigh / cdsTotalMsgs) * 100) : 0;

    // MOR
    const morMsgs = db.prepare(`SELECT body, created_at FROM messages ${tWhere} ORDER BY created_at DESC LIMIT 2000`).all(...tParams) as { body: string; created_at: string }[];
    morTotalMsgs = morMsgs.length;
    for (const m of morMsgs) {
      if (META_SIGNALS.some(s => m.body.includes(s))) {
        morMeta++;
        if (morMessages.length < 20) morMessages.push({ body: m.body.slice(0,80), ts: m.created_at });
      }
    }
    morScore = morTotalMsgs > 0 ? Math.round((morMeta / morTotalMsgs) * 100) : 0;
  } finally {
    db.close();
  }

  const ppdBadge = (sev: string) => `<span class="badge badge-${sev}">${sev}</span>`;
  const cdsClass = cdsScore < CDS_DANGER_THRESHOLD ? 'badge-critical' : cdsScore < CDS_WARNING_THRESHOLD ? 'badge-warning' : '';
  const morClass = morScore >= MOR_DANGER ? 'badge-critical' : morScore >= MOR_WARNING ? 'badge-warning' : '';

  const ppdRows = ppdThreads.map(t =>
    `<tr>
  <td><a href="?view=causaltree&thread=${escAttr(t.rootId)}">${esc(t.rootId.slice(0,8))}…</a></td>
  <td class="cell-num">${t.size}</td>
  <td>${esc(t.sender)} → ${esc(t.recipient)}</td>
  <td>${fmtRelative(t.lastTs)}</td>
  <td>${ppdBadge(t.severity)}</td>
</tr>`
  ).join('');

  const eqsRows = eqsEscalations.slice(0,20).map(e => {
    const respBadge = e.response === 'go'
      ? `<span class="badge" style="background:#39d353;color:#000">GO</span>`
      : e.response === 'non-go'
      ? `<span class="badge badge-critical">non-GO</span>`
      : `<span class="badge" style="background:#484f58;color:#fff">unanswered</span>`;
    return `<tr>
  <td style="font-size:11px">${esc(e.sender)}</td>
  <td style="font-size:11px">${esc(e.recipient)}</td>
  <td style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.body)}</td>
  <td style="font-size:11px">${fmtRelative(e.ts)}</td>
  <td>${respBadge}</td>
</tr>`;
  }).join('');

  const morRows = morMessages.map(m =>
    `<li style="margin-bottom:6px;font-size:11px"><span style="color:var(--text3)">${fmtRelative(m.ts)}</span> — ${esc(m.body)}</li>`
  ).join('');

  const navHtml = renderNav('health');
  const mainHtml = `<div class="alt-main"><div class="view-content">
<h2>🔥 Health Metrics</h2>

<div class="health-section">
  <h3>PPD — Ping-Pong Detection (thread size ≥ ${PPD_THREAD_THRESHOLD})</h3>
  <p class="health-note">Threads with high back-and-forth count may indicate unresolved loops or unclear delegation.</p>
  ${ppdThreads.length === 0
    ? `<p class="dim">(no long threads detected)</p>`
    : `<table class="link-list">
  <thead><tr><th>thread</th><th>size</th><th>root (sender→recipient)</th><th>last active</th><th>severity</th></tr></thead>
  <tbody>${ppdRows}</tbody>
</table>`}
</div>

<div class="health-section">
  <h3>EQS — Escalation Quality Score</h3>
  <p class="health-note">How well are escalations being resolved? GO = operator responded and approved. Non-GO = blocked/revised.</p>
  <div class="detail-stats">
    <div class="stat-box"><span class="stat-num">${eqsTotal}</span><span class="stat-label">escalations (last 100)</span></div>
    <div class="stat-box"><span class="stat-num" style="color:#39d353">${eqsGo}</span><span class="stat-label">GO responses</span></div>
    <div class="stat-box"><span class="stat-num" style="color:#f78166">${eqsNonGo}</span><span class="stat-label">non-GO / blocked</span></div>
    <div class="stat-box"><span class="stat-num" style="color:#7d8590">${eqsUnanswered}</span><span class="stat-label">unanswered</span></div>
  </div>
  ${eqsEscalations.length === 0
    ? `<p class="dim">(no escalations found)</p>`
    : `<table class="link-list">
  <thead><tr><th>sender</th><th>recipient</th><th>body preview</th><th>time</th><th>response</th></tr></thead>
  <tbody>${eqsRows}</tbody>
</table>`}
</div>

<div class="health-section">
  <h3>CDS — Conversation Density Score</h3>
  <p class="health-note">Ratio of high-signal (delegation/completion/problem) to total messages. Ideal: 60–80%. Sampled from last 2000 messages.</p>
  <div class="detail-stats">
    <div class="stat-box">
      <span class="stat-num ${cdsClass ? `badge ${cdsClass}` : ''}">${cdsScore}%</span>
      <span class="stat-label">CDS score</span>
    </div>
    <div class="stat-box"><span class="stat-num">${cdsHigh}</span><span class="stat-label">high-signal msgs</span></div>
    <div class="stat-box"><span class="stat-num">${cdsLow}</span><span class="stat-label">low-signal msgs</span></div>
    <div class="stat-box"><span class="stat-num">${cdsTotalMsgs}</span><span class="stat-label">total sampled</span></div>
  </div>
  ${cdsScore < CDS_DANGER_THRESHOLD ? `<p class="health-note" style="color:#f78166">⚠ CDS below ${CDS_DANGER_THRESHOLD}% — high proportion of acknowledgement/standby messages</p>` : ''}
  ${cdsScore < CDS_WARNING_THRESHOLD && cdsScore >= CDS_DANGER_THRESHOLD ? `<p class="health-note" style="color:#ffa657">⚠ CDS below ${CDS_WARNING_THRESHOLD}% — moderate signal density</p>` : ''}
</div>

<div class="health-section">
  <h3>MOR — Meta-Overhead Ratio</h3>
  <p class="health-note">Ratio of process/rule/role adjustment messages. Ideal: 10–25%. Warning: ${MOR_WARNING}%+. Danger: ${MOR_DANGER}%+.</p>
  <div class="detail-stats">
    <div class="stat-box">
      <span class="stat-num ${morClass ? `badge ${morClass}` : ''}">${morScore}%</span>
      <span class="stat-label">MOR score</span>
    </div>
    <div class="stat-box"><span class="stat-num">${morMeta}</span><span class="stat-label">meta messages</span></div>
    <div class="stat-box"><span class="stat-num">${morTotalMsgs}</span><span class="stat-label">total sampled</span></div>
  </div>
  ${morMessages.length > 0 ? `<h3 style="margin-top:16px">Recent meta messages</h3><ul style="list-style:none;padding:0">${morRows}</ul>` : ''}
</div>
</div></div>`;

  return htmlShell({ view: 'health', totalMsgs, totalAgents, totalLinks, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, prefix });
}
