import { getDb, tenantCond, loadThreadStatuses, effectiveStatus, type EffectiveStatus, type ThreadStatus } from '../db.js';
import { esc, escAttr, fmtTokens } from '../utils.js';
import { htmlShell, renderNav } from '../layout.js';
import { TENANT } from '../constants.js';
import { fetchUsageMap, sumUsage, type TokenUsage } from '../otelite.js';

// 4-state status labels (mirrors v1 _status_badge).
const STATUS_LABEL: Record<EffectiveStatus, string> = {
  running: '▶ running',
  stale: '⚠ stale',
  done: '✓ done',
  stash: '📌 stash',
};

// ── token 燃費バッジ (issue #23) ───────────────────────────────
// otelite の per-msg_id token usage をノードに表示する。↓=input ↑=output ⚡=cache_read。
function fuelBadge(u: TokenUsage | null | undefined): string {
  if (!u) {
    return `<span class="tree-fuel tree-fuel-na" title="otelite に該当 span なし (非LLM経路 / 未収集)">⛽ N/A</span>`;
  }
  const title = `input ${u.input} / output ${u.output} / cache_read ${u.cacheRead}${u.model ? ' · ' + u.model : ''}`;
  return `<span class="tree-fuel" title="${escAttr(title)}">⛽ <span class="tf-in">${fmtTokens(u.input)}↓</span> <span class="tf-out">${fmtTokens(u.output)}↑</span>${u.cacheRead ? ` <span class="tf-cache">${fmtTokens(u.cacheRead)}⚡</span>` : ''}</span>`;
}

function fuelTotalBadge(u: TokenUsage, label: string): string {
  const title = `input ${u.input} / output ${u.output} / cache_read ${u.cacheRead}`;
  if (u.input === 0 && u.output === 0 && u.cacheRead === 0) {
    return `<span class="thread-fuel-total thread-fuel-na" title="otelite データなし">⛽ ${esc(label)}: N/A</span>`;
  }
  return `<span class="thread-fuel-total" title="${escAttr(title)}">⛽ ${esc(label)}: <span class="tf-in">${fmtTokens(u.input)}↓</span> <span class="tf-out">${fmtTokens(u.output)}↑</span>${u.cacheRead ? ` <span class="tf-cache">${fmtTokens(u.cacheRead)}⚡</span>` : ''}</span>`;
}

// ── renderCausalTree ───────────────────────────────────────────
// `prefix` and `totalLinks` are always supplied by the route and lead as required
// params; the four filters derive from optional query strings and trail. Ordering
// (not just defaults) is what makes `totalLinks` required — TS1016 forbids a
// required param after an optional one (issue #31).
export async function renderCausalTree(prefix: string, totalLinks: number, threadId?: string, filterAgent?: string, filterFrom?: string, filterTo?: string): Promise<string> {
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
      // NOTE: root message has no message_causes entry (no caused_by), so we include it
      // via m.id=? in addition to the reply messages matched by mc.root_message_id=?
      const msgs = db.prepare(
        `SELECT m.id, m.sender, m.recipient, m.body, m.created_at, mc.caused_by_id
         FROM messages m
         LEFT JOIN message_causes mc ON mc.message_id=m.id AND mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
         WHERE (m.id=? OR mc.root_message_id=?) ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
         ORDER BY m.created_at ASC`
      ).all(...(tAnd ? tParams : []), threadId, threadId, ...(tAnd ? tParams : [])) as MsgRow[];
      db.close();

      // otelite から per-msg_id の token 燃費を引く (msg_id → trace_id 直引き)
      const usageMap = await fetchUsageMap(msgs.map(m => m.id));
      const threadTotal = sumUsage(msgs.map(m => usageMap.get(m.id) ?? null));

      const msgItems = msgs.map((m, idx) => {
        const isRoot = idx === 0;
        const ts = m.created_at ? m.created_at.replace('T',' ').slice(0,19)+'Z' : '';
        return `<div class="thread-msg ${isRoot ? 'thread-root' : ''}">
  <div class="thread-msg-meta">
    <span style="color:var(--accent)">${esc(m.sender)}</span>
    <span>→</span>
    <span>${esc(m.recipient)}</span>
    ${fuelBadge(usageMap.get(m.id))}
    <span style="margin-left:auto">${esc(ts)}</span>
  </div>
  ${m.caused_by_id ? `<div class="thread-msg-cause">caused by: ${esc(m.caused_by_id.slice(0,8))}…</div>` : ''}
  <div class="thread-msg-body">${esc(m.body)}</div>
</div>`;
      }).join('');

      const navHtml = renderNav('causaltree');
      const mainHtml = `<div class="alt-main"><div class="view-content">
<div class="thread-detail-header">
  <a class="thread-detail-back" href="?view=causaltree">← back to threads</a>
  <span style="font-size:13px;color:var(--accent)">${esc(threadId.slice(0,8))}…</span>
  <span class="dim">${msgs.length} messages</span>
  ${fuelTotalBadge(threadTotal, 'thread')}
</div>
<div class="thread-msg-list">${msgItems}</div>
</div></div>`;
      return htmlShell({ view: 'causaltree', totalMsgs, totalAgents, totalLinks, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, prefix });
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

    // Persisted thread statuses (done/stash/running marks), loaded once per render.
    const statusMap = loadThreadStatuses();
    const tenantKey = TENANT ?? 'default';

    // Phase 1: 各スレッドの msgs を DB から取得 (network 待ちの前に DB を閉じる)
    interface ThreadData { t: typeof threadRows[number]; msgs: MsgRow[]; }
    const threadData: ThreadData[] = [];
    const allMsgIds: string[] = [];
    for (const t of threadRows) {
      const msgs = db.prepare(
        `SELECT m.id, m.sender, m.recipient, m.body, m.created_at, mc.caused_by_id
         FROM messages m
         LEFT JOIN message_causes mc ON mc.message_id=m.id AND mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
         WHERE (m.id=? OR mc.root_message_id=?) ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
         ORDER BY m.created_at ASC`
      ).all(...(tAnd ? tParams : []), t.root_message_id, t.root_message_id, ...(tAnd ? tParams : [])) as MsgRow[];
      threadData.push({ t, msgs });
      for (const m of msgs) allMsgIds.push(m.id);
    }
    db.close();

    // Phase 2: otelite からツリー内 msg の token 燃費を一括取得 (cache + concurrency cap)
    const usageMap = await fetchUsageMap(allMsgIds);

    // Phase 3: render
    const threadHtmlList: string[] = [];
    for (const { t, msgs } of threadData) {
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
        const summary = `<span class="tree-sender">${esc(m.sender)}</span> → <span class="tree-recipient">${esc(m.recipient)}</span>: <span class="tree-body">${esc(m.body.slice(0,60))}</span>${fuelBadge(usageMap.get(m.id))}<span class="tree-time">${esc(ts)}</span>`;
        if (kids.length === 0) {
          return `<div class="tree-node tree-leaf">${summary}</div>`;
        }
        return `<details class="tree-item" ${depth < 2 ? 'open' : ''}>
  <summary class="tree-node">${summary}</summary>
  <div class="tree-children">${kids.map(k => renderTreeNode(k, depth+1)).join('')}</div>
</details>`;
      }

      const treeHtml = roots.map(r => renderTreeNode(r, 0)).join('');
      const rootMsg = msgMap[t.root_message_id];
      const preview = rootMsg ? esc(rootMsg.body.slice(0, 80)) + (rootMsg.body.length > 80 ? '…' : '') : '';
      const rootSender = rootMsg ? esc(rootMsg.sender) : '?';
      const rootRecipient = rootMsg ? esc(rootMsg.recipient) : '?';
      const threadTotal = sumUsage(msgs.map(m => usageMap.get(m.id) ?? null));

      // Effective status (4 states) — faithful port of v1 effective_status.
      const status = effectiveStatus(t.root_message_id, tenantKey, t.thread_end, statusMap);
      const statusTag = `<span class="badge badge-${status}">${STATUS_LABEL[status]}</span>`;

      // Mark buttons (mirrors v1 _status_mark_form): offer the transitions not
      // already in effect — done/stash always available, reopen only when the
      // thread is currently explicitly done/stash.
      const markBtn = (s: ThreadStatus, label: string) =>
        `<button class="ct-mark" data-thread="${escAttr(t.root_message_id)}" data-status="${s}" title="mark ${s}">${label}</button>`;
      const buttons: string[] = [];
      if (status !== 'done') buttons.push(markBtn('done', '✓'));
      if (status !== 'stash') buttons.push(markBtn('stash', '📌'));
      if (status === 'done' || status === 'stash') buttons.push(markBtn('running', '↺'));
      const markButtons = `<span class="ct-mark-btns" onclick="event.stopPropagation()">${buttons.join('')}</span>`;
      threadHtmlList.push(`
<details style="margin-bottom:10px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
  <summary style="padding:10px 14px;background:var(--bg2);cursor:pointer;font-size:12px;list-style:none">
    <div style="display:flex;gap:12px;align-items:center">
      <span style="color:var(--accent)">${rootSender}</span>
      <span style="color:var(--text3)">→</span>
      <span style="color:var(--text)">${rootRecipient}</span>
      <span style="color:var(--text2);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview}</span>
      ${statusTag}
      ${markButtons}
      ${fuelTotalBadge(threadTotal, 'Σ')}
      <span class="dim" style="white-space:nowrap">${t.thread_size} msgs</span>
      <a href="?view=causaltree&thread=${escAttr(t.root_message_id)}" style="font-size:11px;color:var(--accent);white-space:nowrap" onclick="event.stopPropagation()">→ detail</a>
    </div>
  </summary>
  <div style="padding:12px 14px;background:var(--bg)">${treeHtml}</div>
</details>`);
    }

    const filterBar = `<form class="ct-filter-bar" method="get" action=".">
  <input type="hidden" name="view" value="causaltree">
  <label>agent: <input type="text" name="agent_filter" value="${escAttr(filterAgent ?? '')}" placeholder="@handle" style="width:120px"></label>
  <label>from: <input type="date" name="from" value="${escAttr(filterFrom ?? '')}"></label>
  <label>to: <input type="date" name="to" value="${escAttr(filterTo ?? '')}"></label>
  <button type="submit" class="ct-filter-apply">Apply</button>
  <a href="?view=causaltree" style="font-size:11px;color:var(--text2)">reset</a>
</form>`;

    const navHtml = renderNav('causaltree');
    const mainHtml = `<div class="alt-main"><div class="view-content">
<h2>Causal Tree — Thread Explorer</h2>
${filterBar}
<p class="dim" style="margin-bottom:12px">${threadRows.length} threads (top 30 by size) · ⛽ = token 燃費 (otelite, ↓in ↑out ⚡cache)</p>
${threadHtmlList.join('')}
</div></div>
<script>
// Mark buttons → POST the new status, then reload. The fetch URL is relative so
// it resolves against the document's <base href> (the deployment prefix); no
// BASE_PATH interpolation is needed and the script contains no user data.
document.querySelectorAll('.ct-mark').forEach(function (btn) {
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    fetch('api/thread-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: btn.dataset.thread, status: btn.dataset.status })
    }).then(function (r) { if (r.ok) location.reload(); else alert('Failed to update status'); })
      .catch(function () { alert('Failed to update status'); });
  });
});
</script>`;

    return htmlShell({ view: 'causaltree', totalMsgs, totalAgents, totalLinks, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, prefix });
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    throw err;
  }
}
