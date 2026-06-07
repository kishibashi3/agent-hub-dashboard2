import { getDb, tenantCond } from '../db.js';
import { esc, escAttr } from '../utils.js';
import { htmlShell, renderNav } from '../layout.js';

// ── renderCausalTree ───────────────────────────────────────────
export function renderCausalTree(threadId?: string, filterAgent?: string, filterFrom?: string, filterTo?: string): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;

  interface MsgRow { id: string; sender: string; recipient: string; body: string; created_at: string; caused_by_id: string | null; }

  try {
    const tc = tenantCond();
    const tWhere = tc.cond ? 'WHERE ' + tc.cond.slice(4) : '';
    const tAnd = tc.cond;
    const tParams = tc.params;

    totalMsgs = (db.prepare(`SELECT COUNT(*) FROM messages ${tWhere}`).pluck().get(...tParams) as number) ?? 0;
    totalAgents = (db.prepare(`SELECT COUNT(DISTINCT name) FROM participants ${tWhere}`).pluck().get(...tParams) as number) ?? 0;

    if (threadId) {
      // Thread detail view
      const msgs = db.prepare(
        `SELECT m.id, m.sender, m.recipient, m.body, m.created_at, mc.caused_by_id
         FROM messages m
         LEFT JOIN message_causes mc ON mc.message_id=m.id AND mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
         WHERE mc.root_message_id=? ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
         ORDER BY m.created_at ASC`
      ).all(threadId, ...(tAnd ? [...tParams, ...tParams] : [])) as MsgRow[];
      db.close();

      const msgItems = msgs.map((m, idx) => {
        const isRoot = idx === 0;
        const ts = m.created_at ? m.created_at.replace('T',' ').slice(0,19)+'Z' : '';
        return `<div class="thread-msg ${isRoot ? 'thread-root' : ''}">
  <div class="thread-msg-meta">
    <span style="color:var(--accent)">${esc(m.sender)}</span>
    <span>→</span>
    <span>${esc(m.recipient)}</span>
    <span style="margin-left:auto">${esc(ts)}</span>
  </div>
  ${m.caused_by_id ? `<div class="thread-msg-cause">caused by: ${esc(m.caused_by_id.slice(0,8))}…</div>` : ''}
  <div class="thread-msg-body">${esc(m.body)}</div>
</div>`;
      }).join('');

      const navHtml = renderNav('causaltree');
      const mainHtml = `<div class="alt-main"><div class="view-content">
<div class="thread-detail-header">
  <a class="thread-detail-back" href="/?view=causaltree">← back to threads</a>
  <span style="font-size:13px;color:var(--accent)">${esc(threadId.slice(0,8))}…</span>
  <span class="dim">${msgs.length} messages</span>
</div>
<div class="thread-msg-list">${msgItems}</div>
</div></div>`;
      return htmlShell({ view: 'causaltree', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml });
    }

    // Thread list view
    let threadSql = `
      SELECT mc.root_message_id,
             COUNT(*) AS thread_size,
             MIN(m.created_at) AS thread_start,
             MAX(m.created_at) AS thread_end
      FROM message_causes mc
      JOIN messages m ON m.id=mc.message_id ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
      WHERE mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}`;

    const extraParams: unknown[] = [];
    if (filterAgent) {
      threadSql += ` AND mc.root_message_id IN (
        SELECT mc2.root_message_id FROM message_causes mc2
        JOIN messages m2 ON m2.id=mc2.message_id ${tAnd ? tAnd.replace('AND tenant_id', 'AND m2.tenant_id') : ''}
        WHERE mc2.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc2.tenant_id') : ''}
          AND (m2.sender=? OR m2.recipient=?)
      )`;
      extraParams.push(...(tAnd ? [...tParams, ...tParams] : []), filterAgent, filterAgent);
    }
    threadSql += ` GROUP BY mc.root_message_id`;
    if (filterFrom) { threadSql += ` HAVING thread_start >= ?`; extraParams.push(filterFrom); }
    if (filterTo) { threadSql += ` ${filterFrom ? 'AND' : 'HAVING'} thread_start <= ?`; extraParams.push(filterTo + 'T23:59:59Z'); }
    threadSql += ` ORDER BY thread_size DESC LIMIT 30`;

    const baseParams = tAnd ? [...tParams, ...tParams, ...extraParams] : extraParams;
    const threadRows = db.prepare(threadSql).all(...baseParams) as { root_message_id: string; thread_size: number; thread_start: string | null; thread_end: string | null }[];

    // For each thread, get messages to build tree
    const threadHtmlList: string[] = [];
    for (const t of threadRows) {
      const msgs = db.prepare(
        `SELECT m.id, m.sender, m.recipient, m.body, m.created_at, mc.caused_by_id
         FROM messages m
         LEFT JOIN message_causes mc ON mc.message_id=m.id AND mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
         WHERE mc.root_message_id=? ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
         ORDER BY m.created_at ASC`
      ).all(t.root_message_id, ...(tAnd ? [...tParams, ...tParams] : [])) as MsgRow[];

      // Build children map
      const children: Record<string, string[]> = {};
      const msgMap: Record<string, MsgRow> = {};
      const roots: string[] = [];
      for (const m of msgs) {
        msgMap[m.id] = m;
        if (m.caused_by_id) {
          if (!children[m.caused_by_id]) children[m.caused_by_id] = [];
          children[m.caused_by_id].push(m.id);
        } else {
          roots.push(m.id);
        }
      }

      function renderTreeNode(id: string, depth: number): string {
        const m = msgMap[id];
        if (!m) return '';
        const kids = children[id] ?? [];
        const ts = m.created_at ? m.created_at.replace('T',' ').slice(0,13)+'Z' : '';
        const summary = `<span class="tree-sender">${esc(m.sender)}</span> → <span class="tree-recipient">${esc(m.recipient)}</span>: <span class="tree-body">${esc(m.body.slice(0,60))}</span><span class="tree-time">${esc(ts)}</span>`;
        if (kids.length === 0) {
          return `<div class="tree-node tree-leaf">${summary}</div>`;
        }
        return `<details class="tree-item" ${depth < 2 ? 'open' : ''}>
  <summary class="tree-node">${summary}</summary>
  <div class="tree-children">${kids.map(k => renderTreeNode(k, depth+1)).join('')}</div>
</details>`;
      }

      const treeHtml = roots.map(r => renderTreeNode(r, 0)).join('');
      const startStr = t.thread_start ? t.thread_start.replace('T',' ').slice(0,16)+'Z' : '?';
      const endStr = t.thread_end ? t.thread_end.replace('T',' ').slice(0,16)+'Z' : '?';
      threadHtmlList.push(`
<details style="margin-bottom:10px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
  <summary style="padding:10px 14px;background:var(--bg2);cursor:pointer;font-size:12px;list-style:none;display:flex;gap:12px;align-items:center">
    <span style="color:var(--accent)">${esc(t.root_message_id.slice(0,8))}…</span>
    <span class="dim">${t.thread_size} msgs</span>
    <span class="dim">${esc(startStr)} → ${esc(endStr)}</span>
    <a href="/?view=causaltree&thread=${escAttr(t.root_message_id)}" style="margin-left:auto;font-size:11px;color:var(--accent)" onclick="event.stopPropagation()">→ detail</a>
  </summary>
  <div style="padding:12px 14px;background:var(--bg)">${treeHtml}</div>
</details>`);
    }
    db.close();

    const filterBar = `<form class="ct-filter-bar" method="get" action="/">
  <input type="hidden" name="view" value="causaltree">
  <label>agent: <input type="text" name="agent" value="${escAttr(filterAgent ?? '')}" placeholder="@handle" style="width:120px"></label>
  <label>from: <input type="date" name="from" value="${escAttr(filterFrom ?? '')}"></label>
  <label>to: <input type="date" name="to" value="${escAttr(filterTo ?? '')}"></label>
  <button type="submit" class="ct-filter-apply">Apply</button>
  <a href="/?view=causaltree" style="font-size:11px;color:var(--text2)">reset</a>
</form>`;

    const navHtml = renderNav('causaltree');
    const mainHtml = `<div class="alt-main"><div class="view-content">
<h2>Causal Tree — Thread Explorer</h2>
${filterBar}
<p class="dim" style="margin-bottom:12px">${threadRows.length} threads (top 30 by size)</p>
${threadHtmlList.join('')}
</div></div>`;

    return htmlShell({ view: 'causaltree', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml });
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    throw err;
  }
}
