import { getDb, tenantCond } from '../db.js';
import { esc, escAttr } from '../utils.js';
import { htmlShell, renderNav } from '../layout.js';
import { TENANT, BASE_PATH } from '../constants.js';

// ── renderAgent ────────────────────────────────────────────────
export function renderAgent(handle: string): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;
  interface AgentData {
    found: boolean; inCount: number; outCount: number; total: number;
    lastActive: string | null; mode: string | null;
    topPeers: { peer: string; count: number }[];
    tenantsIn: string[];
  }
  let d: AgentData = { found: false, inCount: 0, outCount: 0, total: 0, lastActive: null, mode: null, topPeers: [], tenantsIn: [] };

  try {
    const tc = tenantCond();
    totalMsgs = (db.prepare(`SELECT COUNT(*) FROM messages ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`).pluck().get(...tc.params) as number) ?? 0;
    totalAgents = (db.prepare(`SELECT COUNT(DISTINCT name) FROM participants ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`).pluck().get(...tc.params) as number) ?? 0;

    const tAnd = tc.cond ? tc.cond : '';
    const tParams = tc.params;

    const inCount = (db.prepare(`SELECT COUNT(*) FROM messages WHERE recipient = ? ${tAnd}`).pluck().get(handle, ...tParams) as number) ?? 0;
    const outCount = (db.prepare(`SELECT COUNT(*) FROM messages WHERE sender = ? ${tAnd}`).pluck().get(handle, ...tParams) as number) ?? 0;
    const lastActive = db.prepare(`SELECT MAX(created_at) FROM messages WHERE (sender = ? OR recipient = ?) ${tAnd}`).pluck().get(handle, handle, ...tParams) as string | null;

    let mode: string | null = null;
    if (TENANT === null) {
      const modeRow = db.prepare('SELECT mode FROM participants WHERE name = ? LIMIT 1').get(handle) as { mode: string } | undefined;
      mode = modeRow?.mode ?? null;
    } else {
      const modeRow = db.prepare('SELECT mode FROM participants WHERE name = ? AND tenant_id = ?').get(handle, TENANT) as { mode: string } | undefined;
      mode = modeRow?.mode ?? null;
    }

    const found = mode !== null || (inCount + outCount) > 0;
    const peerRows = db.prepare(`
      SELECT peer, SUM(c) AS total FROM (
        SELECT recipient AS peer, COUNT(*) AS c FROM messages WHERE sender = ? ${tAnd} GROUP BY recipient
        UNION ALL
        SELECT sender AS peer, COUNT(*) AS c FROM messages WHERE recipient = ? ${tAnd} GROUP BY sender
      ) GROUP BY peer ORDER BY total DESC LIMIT 20
    `).all(handle, ...tParams, handle, ...tParams) as { peer: string; total: number }[];

    const topPeers = peerRows.map(r => ({ peer: r.peer, count: r.total }));

    let tenantsIn: string[] = [];
    if (TENANT === null) {
      const tRows = db.prepare('SELECT DISTINCT tenant_id FROM messages WHERE sender = ? OR recipient = ?').all(handle, handle) as { tenant_id: string }[];
      tenantsIn = tRows.map(r => r.tenant_id);
    } else if (inCount + outCount > 0) {
      tenantsIn = [TENANT];
    }

    d = { found, inCount, outCount, total: inCount + outCount, lastActive, mode, topPeers, tenantsIn };
  } finally {
    db.close();
  }

  const h = esc(handle);
  const navHtml = renderNav('agent', handle);

  let bodyHtml: string;
  if (!d.found) {
    bodyHtml = `<div class="view-content"><h2>Agent Detail</h2>
<div class="detail-card"><p style="color:var(--text2);font-size:13px;padding:20px;text-align:center">
agent <strong>${h}</strong> not found in ${esc(TENANT ?? 'any tenant')}.
</p></div></div>`;
  } else {
    const peerList = d.topPeers.length
      ? `<ol class="peer-list">${d.topPeers.map(p =>
          `<li><a href="${BASE_PATH}/?agent=${escAttr(p.peer)}">${esc(p.peer)}</a> <span class="dim">${p.count} msgs</span></li>`
        ).join('')}</ol>`
      : `<p class="dim">(no peers)</p>`;

    bodyHtml = `<div class="view-content">
<h2>Agent Detail: ${h}</h2>
<div class="detail-card">
  <div class="detail-stats">
    <div class="stat-box"><span class="stat-num">${d.total}</span><span class="stat-label">total messages</span></div>
    <div class="stat-box"><span class="stat-num">${d.inCount}</span><span class="stat-label">received (in)</span></div>
    <div class="stat-box"><span class="stat-num">${d.outCount}</span><span class="stat-label">sent (out)</span></div>
    <div class="stat-box"><span class="stat-num">${d.topPeers.length}</span><span class="stat-label">distinct peers</span></div>
  </div>
  <table class="detail-meta">
    <tr><th>type (mode)</th><td>${esc(d.mode ?? '(unknown)')}</td></tr>
    <tr><th>last active</th><td>${esc(d.lastActive ?? '(no messages)')}</td></tr>
    <tr><th>tenants active in</th><td>${esc(d.tenantsIn.join(', ') || '(none)')}</td></tr>
  </table>
  <h3>Top peers (bidirectional message count)</h3>
  ${peerList}
</div></div>`;
  }

  const mainHtml = `<div class="alt-main">${bodyHtml}</div>`;
  return htmlShell({ view: 'agent', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml });
}
