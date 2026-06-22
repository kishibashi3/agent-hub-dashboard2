import { getDb, tenantCond } from '../db.js';
import { esc, escAttr, fmtRelative, computePresence } from '../utils.js';
import { htmlShell, renderNav } from '../layout.js';
import { STALE_HOURS } from '../constants.js';

// ── renderCurrent ──────────────────────────────────────────────
export function renderCurrent(prefix: string, totalLinks: number): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;

  interface Peer { name: string; displayName: string | null; lastActiveAt: string | null; queueDepth: number; presence: string; currentTaskPreview: string; }
  interface Task { rootId: string; size: number; start: string | null; end: string | null; participants: string[]; lastRecipient: string | null; preview: string; isStuck: boolean; }

  let peers: Peer[] = [];
  let tasks: Task[] = [];

  try {
    const tc = tenantCond();
    const tWhere = tc.cond ? 'WHERE ' + tc.cond.slice(4) : '';
    const tAnd = tc.cond;
    const tParams = tc.params;

    totalMsgs = (db.prepare(`SELECT COUNT(*) FROM messages ${tWhere}`).pluck().get(...tParams) as number) ?? 0;
    totalAgents = (db.prepare(`SELECT COUNT(DISTINCT name) FROM participants ${tWhere}`).pluck().get(...tParams) as number) ?? 0;

    const peerRows = db.prepare(
      `SELECT name, display_name, last_active_at FROM participants WHERE deleted_at IS NULL ${tAnd} ORDER BY last_active_at DESC`
    ).all(...tParams) as { name: string; display_name: string | null; last_active_at: string | null }[];

    // unread queue per recipient
    const queueRows = db.prepare(
      `SELECT m.recipient, COUNT(*) AS queue_depth
       FROM messages m
       LEFT JOIN read_receipts rr ON rr.tenant_id=m.tenant_id AND rr.message_id=m.id AND rr.reader=m.recipient
       WHERE rr.message_id IS NULL ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
       GROUP BY m.recipient`
    ).all(...tParams) as { recipient: string; queue_depth: number }[];
    const queueMap: Record<string, number> = {};
    for (const r of queueRows) queueMap[r.recipient] = r.queue_depth;

    // oldest unread message per recipient — used for "current task" display
    const unreadRows = db.prepare(
      `SELECT m.recipient, m.sender, m.body
       FROM messages m
       LEFT JOIN read_receipts rr ON rr.tenant_id=m.tenant_id AND rr.message_id=m.id AND rr.reader=m.recipient
       WHERE rr.message_id IS NULL ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
       ORDER BY m.recipient, m.created_at ASC
       LIMIT 500`
    ).all(...tParams) as { recipient: string; sender: string; body: string }[];
    const unreadPreviewMap: Record<string, string> = {};
    for (const r of unreadRows) {
      if (!unreadPreviewMap[r.recipient]) {
        unreadPreviewMap[r.recipient] = `${r.sender}: ${r.body.slice(0, 55)}`;
      }
    }

    peers = peerRows.map(p => ({
      name: p.name,
      displayName: p.display_name,
      lastActiveAt: p.last_active_at,
      queueDepth: queueMap[p.name] ?? 0,
      presence: computePresence(p.last_active_at),
      currentTaskPreview: (queueMap[p.name] ?? 0) > 0 ? (unreadPreviewMap[p.name] ?? '') : '',
    }));

    // top 30 active threads
    const taskRows = db.prepare(
      `SELECT mc.root_message_id,
              COUNT(*) AS thread_size,
              MIN(m.created_at) AS thread_start,
              MAX(m.created_at) AS thread_end,
              GROUP_CONCAT(DISTINCT m.sender) AS participants_raw,
              MAX(m.recipient) AS last_recipient
       FROM message_causes mc
       JOIN messages m ON m.id=mc.message_id ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
       WHERE mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
       GROUP BY mc.root_message_id
       ORDER BY thread_end DESC
       LIMIT 30`
    ).all(...(tAnd ? [...tParams, ...tParams] : [])) as {
      root_message_id: string; thread_size: number; thread_start: string | null;
      thread_end: string | null; participants_raw: string | null; last_recipient: string | null;
    }[];

    const now = Date.now();
    for (const t of taskRows) {
      const rootMsg = db.prepare(`SELECT body FROM messages WHERE id = ? ${tAnd} LIMIT 1`).get(t.root_message_id, ...tParams) as { body: string } | undefined;
      const preview = rootMsg?.body?.slice(0, 60) ?? t.root_message_id.slice(0, 8);
      const endMs = t.thread_end ? new Date(t.thread_end).getTime() : 0;
      const isStuck = endMs > 0 && (now - endMs) > STALE_HOURS * 3600 * 1000;
      tasks.push({
        rootId: t.root_message_id,
        size: t.thread_size,
        start: t.thread_start,
        end: t.thread_end,
        participants: t.participants_raw ? t.participants_raw.split(',').filter(Boolean) : [],
        lastRecipient: t.last_recipient,
        preview,
        isStuck,
      });
    }
  } finally {
    db.close();
  }

  function queueBadge(depth: number): string {
    const cls = depth === 0 ? 'queue-badge-0' : depth < 10 ? 'queue-badge-low' : 'queue-badge-high';
    return `<span class="queue-badge ${cls}">${depth}</span>`;
  }

  const peerRows2 = peers.map(p => {
    const taskLink = p.currentTaskPreview
      ? `<span style="color:var(--text2);font-size:11px">${esc(p.currentTaskPreview)}</span>`
      : `<span style="color:var(--text3);font-size:11px">—</span>`;
    const dispName = p.displayName && p.displayName !== p.name ? ` <span style="font-size:10px;color:var(--text2)">${esc(p.displayName)}</span>` : '';
    return `<tr>
  <td><a href="?agent=${escAttr(p.name)}" style="color:var(--accent);text-decoration:none">${esc(p.name)}</a>${dispName}</td>
  <td><span class="presence-dot presence-${esc(p.presence)}"></span>${esc(p.presence)}</td>
  <td>${queueBadge(p.queueDepth)}</td>
  <td>${taskLink}</td>
  <td style="font-size:11px;color:var(--text3)">${fmtRelative(p.lastActiveAt)}</td>
</tr>`;
  }).join('');

  const taskRows2 = tasks.map(t =>
    `<tr>
  <td><a href="?view=causaltree&thread=${escAttr(t.rootId)}">${esc(t.rootId.slice(0,8))}…</a><br>
      <span style="font-size:10px;color:var(--text2)">${esc(t.preview)}</span></td>
  <td class="cell-num">${t.size}</td>
  <td style="font-size:11px">${fmtRelative(t.end)}</td>
  <td style="font-size:11px">${esc(t.participants.slice(0,4).join(', '))}</td>
  <td>${t.isStuck ? "<span class='badge badge-stale'>stale</span>" : ''}</td>
</tr>`
  ).join('');

  const navHtml = renderNav('current');
  const mainHtml = `<div class="alt-main"><div class="view-content">
<h2>⚡ Current — Peer Status &amp; Active Tasks</h2>
<h3>Peer Status</h3>
<table class="peer-table">
<thead><tr><th>agent</th><th>presence</th><th>queue</th><th>current task</th><th>last active</th></tr></thead>
<tbody>${peerRows2}</tbody>
</table>
<h3 style="margin-top:28px">Current Tasks (top 30 by last activity)</h3>
<table class="link-list">
<thead><tr><th>thread</th><th>size</th><th>last active</th><th>participants</th><th>status</th></tr></thead>
<tbody>${taskRows2}</tbody>
</table>
</div></div>`;

  return htmlShell({ view: 'current', totalMsgs, totalAgents, totalLinks, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, prefix });
}
