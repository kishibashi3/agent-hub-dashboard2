import { getDb, tenantCond } from '../db.js';
import { esc, escAttr } from '../utils.js';
import { htmlShell, renderNav } from '../layout.js';

// ── renderLinks ────────────────────────────────────────────────
export function renderLinks(prefix: string, totalLinks: number): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;
  let items: { a: string; b: string; total: number; aToB: number; bToA: number }[] = [];

  try {
    const tc = tenantCond();
    totalMsgs = (db.prepare(`SELECT COUNT(*) FROM messages ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`).pluck().get(...tc.params) as number) ?? 0;
    totalAgents = (db.prepare(`SELECT COUNT(DISTINCT name) FROM participants ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`).pluck().get(...tc.params) as number) ?? 0;

    const rows = db.prepare(
      `SELECT sender, recipient, COUNT(*) FROM messages ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''} GROUP BY sender, recipient`
    ).raw(true).all(...tc.params) as [string, string, number][]; // .raw(true): row を配列で受け取る（デフォルトのオブジェクト形式は for..of destructuring 不可）

    const agg: Record<string, { total: number; aToB: number; bToA: number }> = {};
    for (const [s, r, c] of rows) {
      if (s === r) continue;
      const [a, b] = s < r ? [s, r] : [r, s];
      const key = `${a}|||${b}`;
      if (!agg[key]) agg[key] = { total: 0, aToB: 0, bToA: 0 };
      agg[key].total += c;
      if (s === a) agg[key].aToB += c;
      else agg[key].bToA += c;
    }
    items = Object.entries(agg).map(([k, v]) => {
      const [a, b] = k.split('|||');
      return { a, b, ...v };
    }).sort((x, y) => y.total - x.total).slice(0, 50);
  } finally {
    db.close();
  }

  const maxTotal = items.length ? Math.max(...items.map(i => i.total)) : 1;
  const rows = items.map((link, i) =>
    `<tr>
  <td class="rank">${i + 1}</td>
  <td><a href="?agent=${escAttr(link.a)}">${esc(link.a)}</a> &nbsp;↔&nbsp; <a href="?agent=${escAttr(link.b)}">${esc(link.b)}</a></td>
  <td class="cell-num">${link.total}</td>
  <td class="cell-num dim">${link.aToB}→</td>
  <td class="cell-num dim">←${link.bToA}</td>
  <td class="bar-cell"><div class="bar" style="width:${Math.floor((link.total/maxTotal)*100)}%"></div></td>
</tr>`
  ).join('');

  const navHtml = renderNav('links');
  const mainHtml = `<div class="alt-main"><div class="view-content">
<h2>Link List — top ${items.length} strongest links</h2>
<p class="dim">bidirectional message exchange (a↔b) · click handle for Agent Detail</p>
<table class="link-list">
  <thead><tr><th>#</th><th>link</th><th>total</th><th>a→b</th><th>b→a</th><th>volume</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div></div>`;

  // Header `active links` uses the global v1-faithful count (mesh getData().links,
  // c>=3 undirected pairs) passed in by the caller — NOT `items.length`, which is
  // this view's top-50 list slice (different definition). The list heading below
  // keeps using items.length for its own "top N" label.
  return htmlShell({ view: 'links', totalMsgs, totalAgents, totalLinks, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, prefix });
}
