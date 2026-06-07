import { getDb, tenantCond } from '../db.js';
import { esc, escAttr } from '../utils.js';
import { htmlShell, renderNav } from '../layout.js';

// ── MeshData ───────────────────────────────────────────────────
export interface MeshData {
  top: string[];
  counts: Record<string, number>;
  totals: Record<string, number>;
  nodes: { id: string; total: number; team: boolean }[];
  links: { source: string; target: string; value: number }[];
  totalMsgs: number;
  totalAgents: number;
}

// ── getData ────────────────────────────────────────────────────
export function getData(): MeshData {
  const db = getDb();
  try {
    const tc = tenantCond();
    const rows = db.prepare(
      `SELECT sender, recipient, COUNT(*) FROM messages ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''} GROUP BY sender, recipient`
    ).all(...tc.params) as [string, string, number][];

    const totalMsgs = (db.prepare(
      `SELECT COUNT(*) FROM messages ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`
    ).pluck().get(...tc.params) as number) ?? 0;

    const totalAgents = (db.prepare(
      `SELECT COUNT(DISTINCT name) FROM participants ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`
    ).pluck().get(...tc.params) as number) ?? 0;

    const teamRows = db.prepare(
      `SELECT name FROM teams ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`
    ).all(...tc.params) as { name: string }[];
    const teams = new Set(teamRows.map(r => r.name));

    const counts: Record<string, number> = {};
    const totals: Record<string, number> = {};
    const linksRaw: Record<string, number> = {};

    for (const [s, r, c] of rows) {
      counts[`${s}|${r}`] = c;
      totals[s] = (totals[s] ?? 0) + c;
      totals[r] = (totals[r] ?? 0) + c;
      const key = [s, r].sort().join('|');
      linksRaw[key] = (linksRaw[key] ?? 0) + c;
    }

    const top = Object.keys(totals).sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0));
    const topSet = new Set(top);
    const nodes = top.map(n => ({ id: n, total: totals[n] ?? 0, team: teams.has(n) }));
    const links = Object.entries(linksRaw)
      .filter(([k, c]) => {
        const [a, b] = k.split('|');
        return topSet.has(a) && topSet.has(b) && c >= 3;
      })
      .map(([k, value]) => {
        const [source, target] = k.split('|');
        return { source, target, value };
      });

    return { top, counts, totals, nodes, links, totalMsgs, totalAgents };
  } finally {
    db.close();
  }
}

// ── buildHeatmap ───────────────────────────────────────────────
export function buildHeatmap(top: string[], counts: Record<string, number>, totals: Record<string, number>): string {
  const maxVal = Math.max(
    1,
    ...top.flatMap(s => top.filter(r => r !== s).map(r => counts[`${s}|${r}`] ?? 0))
  );

  function cellBg(n: number): string {
    if (n === 0) return '#0d1117';
    const t = n / maxVal;
    const r = Math.floor(13 + t * 108);
    const g = Math.floor(17 + t * 175);
    const b = Math.floor(23 + t * 232);
    return `rgb(${r},${g},${b})`;
  }
  function cellFg(n: number): string {
    return n / maxVal > 0.45 ? '#0d1117' : '#e6edf3';
  }

  const lines: string[] = ['<table class="hm">'];
  lines.push('<tr><th class="rl">from \\ to</th>');
  for (const r of top) lines.push(`<th>${esc(r.startsWith('@') ? r.slice(1, 9) : r.slice(0, 8))}</th>`);
  lines.push('<th class="tc">tot</th></tr>');

  for (const s of top) {
    lines.push('<tr>');
    lines.push(`<th class="rl">${esc(s)}</th>`);
    for (const r of top) {
      if (s === r) {
        lines.push('<td class="self">—</td>');
      } else {
        const n = counts[`${s}|${r}`] ?? 0;
        const bg = cellBg(n);
        const fg = n ? cellFg(n) : '#21262d';
        lines.push(
          `<td style="background:${bg};color:${fg}" data-n="${n}" data-from="${escAttr(s)}" data-to="${escAttr(r)}">${esc(n ? String(n) : '')}</td>`
        );
      }
    }
    lines.push(`<td class="tc">${totals[s] ?? 0}</td></tr>`);
  }
  lines.push('</table>');
  return lines.join('\n');
}

// ── renderMesh ─────────────────────────────────────────────────
export function renderMesh(data: MeshData): string {
  const { top, counts, totals, nodes, links, totalMsgs, totalAgents } = data;
  const heatmapHtml = buildHeatmap(top, counts, totals);
  const nodeDefault = Math.min(top.length, 14);
  const navHtml = renderNav('mesh');
  const mainHtml = `<div id="main">
  <div id="graph-pane"><svg id="svg"></svg><div id="graph-hint" style="position:absolute;bottom:10px;left:12px;font-size:10px;color:var(--text4);pointer-events:none">drag: move node &nbsp; scroll: zoom</div></div>
  <div id="divider"></div>
  <div id="heatmap-pane"><h2>message matrix</h2>${heatmapHtml}</div>
</div>`;

  return htmlShell({
    view: 'mesh',
    totalMsgs,
    totalAgents,
    totalLinks: links.length,
    nodeCount: nodes.length,
    nodeDefault,
    navHtml,
    mainHtml,
    nodesJson: JSON.stringify(nodes),
    linksJson: JSON.stringify(links),
  });
}

// ── renderMatrix ───────────────────────────────────────────────
export function renderMatrix(data: MeshData): string {
  const { top, counts, totals, links, totalMsgs, totalAgents } = data;
  const heatmapHtml = buildHeatmap(top, counts, totals);
  const navHtml = renderNav('matrix');
  const mainHtml = `<div id="main" class="matrix-only-layout">
  <div id="heatmap-pane"><h2>message matrix</h2>${heatmapHtml}</div>
</div>`;

  return htmlShell({
    view: 'matrix',
    totalMsgs,
    totalAgents,
    totalLinks: links.length,
    nodeCount: 0,
    nodeDefault: 0,
    navHtml,
    mainHtml,
  });
}
