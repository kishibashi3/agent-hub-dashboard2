import { esc, escAttr } from './utils.js';
import { TENANT, BASE_PATH } from './constants.js';

// ── Security helpers ───────────────────────────────────────────
/**
 * Escape a JSON string for safe inline `<script>` embedding.
 * Replaces `</` → `<\/` and `<!--` → `<\!--` so the HTML parser
 * never sees a `</script>` or `<!--` token inside the JSON value.
 */
function jsonForScript(json: string): string {
  return json.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

/**
 * Opaque brand for script strings that have been vetted as
 * author-controlled (never derived from user-supplied data).
 * Callers must explicitly call `asTrustedScript(s)`.
 */
export type TrustedScript = string & { readonly __brand: 'TrustedScript' };
export function asTrustedScript(s: string): TrustedScript {
  return s as TrustedScript;
}

// ── CSS ────────────────────────────────────────────────────────
export const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:#fff; --bg2:#fafafa; --bg3:#f8f9fa;
  --text:#1a1a1a; --text2:#666; --text3:#aaa; --text4:#bbb;
  --border:#e0e0e0; --border2:#f0f0f0;
  --accent:#1a73e8; --hover:#58a6ff;
  --tip-bg:#fff; --tip-border:#ddd; --tip-shadow:rgba(0,0,0,0.12);
  --self-bg:#f5f5f5; --self-fg:#ccc; --edge:#ccc; --node-text:#333;
}
body.dark {
  --bg:#0d1117; --bg2:#0d1117; --bg3:#0d1117;
  --text:#e6edf3; --text2:#7d8590; --text3:#484f58; --text4:#484f58;
  --border:#21262d; --border2:#161b22;
  --accent:#a5d6ff; --hover:#58a6ff;
  --tip-bg:#161b22; --tip-border:#30363d; --tip-shadow:rgba(0,0,0,0.4);
  --self-bg:#0d1117; --self-fg:#21262d; --edge:#30363d; --node-text:#e6edf3;
}
body { background:var(--bg); color:var(--text); font-family:monospace; height:100vh; display:flex; flex-direction:column; transition:background 0.2s,color 0.2s; }
#header { display:flex; align-items:center; gap:24px; padding:10px 20px; border-bottom:1px solid var(--border); flex-shrink:0; background:var(--bg2); }
#header h1 { font-size:14px; color:var(--accent); letter-spacing:0.05em; }
.stat { font-size:11px; color:var(--text2); }
.stat strong { color:var(--text); font-size:16px; margin-right:4px; }
#header-right { margin-left:auto; display:flex; align-items:center; gap:12px; font-size:11px; color:var(--text3); }
#theme-btn { background:none; border:1px solid var(--border); color:var(--text2); padding:3px 10px; border-radius:4px; cursor:pointer; font-family:monospace; font-size:11px; transition:border-color 0.15s,color 0.15s; }
#theme-btn:hover { border-color:var(--accent); color:var(--accent); }
#nav-bar { display:flex; gap:0; align-items:center; padding:0 20px; background:var(--bg2); border-bottom:1px solid var(--border); flex-shrink:0; font-size:11px; }
#nav-bar a { padding:8px 14px; color:var(--text2); text-decoration:none; border-bottom:2px solid transparent; transition:color 0.15s, border-color 0.15s; }
#nav-bar a:hover { color:var(--text); }
#nav-bar a.active { color:var(--accent); border-bottom-color:var(--accent); }
.nav-divider { width:1px; height:18px; background:var(--border); margin:0 6px; align-self:center; }
.nav-section-label { font-size:9px; color:var(--text3); text-transform:uppercase; letter-spacing:0.1em; padding:0 8px 0 4px; align-self:center; user-select:none; }
#main { display:flex; flex:1; overflow:hidden; }
#graph-pane { flex:1; position:relative; min-width:200px; background:var(--bg3); overflow:hidden; }
#graph-pane svg { width:100%; height:100%; }
#divider { width:5px; flex-shrink:0; cursor:col-resize; background:var(--border); transition:background 0.15s; }
#divider:hover, #divider.dragging { background:var(--accent); }
#heatmap-pane { width:600px; overflow:auto; padding:16px 20px; flex-shrink:0; min-width:200px; background:var(--bg); }
#heatmap-pane h2 { font-size:11px; color:var(--text2); margin-bottom:10px; letter-spacing:0.08em; text-transform:uppercase; }
table.hm { border-collapse:collapse; font-size:10px; }
table.hm th { color:var(--text2); padding:3px 5px; white-space:nowrap; }
table.hm th.rl { text-align:right; min-width:120px; color:var(--accent); font-size:10px; }
table.hm td { width:38px; height:38px; text-align:center; border:1px solid var(--border2); cursor:default; font-size:11px; }
table.hm td:hover { outline:1px solid var(--hover); }
table.hm td.self { background:var(--self-bg); color:var(--self-fg); }
.tc { font-size:9px; color:var(--text2); padding:0 6px; }
#tooltip { position:fixed; background:var(--tip-bg); border:1px solid var(--tip-border); padding:8px 12px; font-size:11px; border-radius:6px; pointer-events:none; display:none; line-height:1.8; z-index:99; box-shadow:0 2px 8px var(--tip-shadow); }
.alt-main { flex:1; overflow:auto; padding:20px 24px; background:var(--bg); }
.view-content h2 { font-size:16px; color:var(--accent); margin-bottom:14px; letter-spacing:0.03em; }
.view-content h3 { font-size:12px; color:var(--text2); margin:18px 0 8px; text-transform:uppercase; letter-spacing:0.08em; }
.view-content .dim { color:var(--text2); font-size:11px; }
.detail-card { background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:18px; max-width:900px; }
.detail-stats { display:flex; gap:14px; margin-bottom:18px; flex-wrap:wrap; }
.detail-stats .stat-box { display:flex; flex-direction:column; align-items:center; padding:12px 18px; background:var(--bg3); border:1px solid var(--border2); border-radius:6px; min-width:120px; }
.detail-stats .stat-num { font-size:24px; color:var(--accent); font-weight:bold; }
.detail-stats .stat-label { font-size:10px; color:var(--text2); margin-top:4px; text-align:center; }
.detail-meta { width:100%; font-size:12px; margin:14px 0; border-collapse:collapse; }
.detail-meta th { text-align:left; color:var(--text2); font-weight:normal; padding:6px 12px 6px 0; width:140px; vertical-align:top; }
.detail-meta td { padding:6px 0; color:var(--text); }
.peer-list { list-style:decimal inside; padding-left:0; columns:2; column-gap:24px; font-size:12px; }
.peer-list li { padding:4px 0; }
.peer-list a { color:var(--accent); text-decoration:none; }
.peer-list a:hover { text-decoration:underline; }
.peer-list .dim { font-size:10px; margin-left:6px; }
.timeline-controls { display:flex; align-items:center; gap:8px; font-size:11px; margin-bottom:8px; }
.range-btn { padding:4px 10px; border:1px solid var(--border); color:var(--text2); text-decoration:none; border-radius:4px; transition:border-color 0.15s, color 0.15s; }
.range-btn:hover { color:var(--accent); border-color:var(--accent); }
.range-btn.active { color:var(--accent); border-color:var(--accent); background:var(--bg2); }
table.link-list { width:100%; max-width:900px; border-collapse:collapse; font-size:12px; margin-top:8px; }
table.link-list th, table.link-list td { padding:6px 10px; border-bottom:1px solid var(--border2); text-align:left; }
table.link-list th { color:var(--text2); font-weight:normal; font-size:10px; text-transform:uppercase; letter-spacing:0.05em; }
table.link-list .rank { color:var(--text3); width:36px; }
table.link-list .cell-num { text-align:right; width:60px; }
table.link-list a { color:var(--accent); text-decoration:none; }
table.link-list a:hover { text-decoration:underline; }
table.link-list .bar-cell { width:200px; }
table.link-list .bar { height:8px; background:var(--accent); border-radius:2px; opacity:0.7; }
.badge { display:inline-block; padding:2px 8px; border-radius:3px; font-size:10px; font-weight:bold; letter-spacing:0.04em; }
.badge-warning { background:#ffa657; color:#000; }
.badge-critical { background:#f78166; color:#fff; }
.badge-severe { background:#da3633; color:#fff; }
.badge-stale { background:#ffa657; color:#000; }
.health-section { margin-top:28px; }
.health-section h3 { font-size:12px; color:var(--text2); margin:0 0 6px; text-transform:uppercase; letter-spacing:0.08em; }
.health-note { font-size:11px; color:var(--text2); margin:4px 0 8px; }
.tree-node { padding:5px 0; font-size:12px; }
.tree-leaf { color:var(--text2); }
.tree-children { padding-left:20px; border-left:2px solid var(--border2); margin-left:8px; }
.tree-sender { color:var(--accent); }
.tree-recipient { color:var(--text); }
.tree-body { color:var(--text2); font-size:11px; }
.tree-time { color:var(--text3); font-size:10px; margin-left:6px; }
details.tree-item > summary { cursor:pointer; list-style:none; }
details.tree-item > summary::-webkit-details-marker { display:none; }
details.tree-item > summary::before { content:'▶ '; font-size:9px; color:var(--text3); margin-right:3px; }
details.tree-item[open] > summary::before { content:'▼ '; }
.ct-filter-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px 12px; background:var(--bg2); border:1px solid var(--border); border-radius:6px; margin-bottom:14px; font-size:11px; }
.ct-filter-bar label { color:var(--text2); }
.ct-filter-bar input[type=text], .ct-filter-bar select, .ct-filter-bar input[type=date] { padding:3px 7px; border:1px solid var(--border); border-radius:4px; background:var(--bg); color:var(--text); font-family:monospace; font-size:11px; }
.ct-filter-apply { padding:3px 12px; background:var(--accent); color:#fff; border:none; border-radius:4px; cursor:pointer; font-family:monospace; font-size:11px; }
.thread-detail-header { display:flex; align-items:center; gap:12px; margin-bottom:18px; flex-wrap:wrap; }
.thread-detail-back { font-size:11px; color:var(--accent); text-decoration:none; padding:4px 10px; border:1px solid var(--border); border-radius:4px; }
.thread-msg-list { max-width:780px; }
.thread-msg { padding:12px 14px; border-left:3px solid var(--border2); margin-bottom:8px; background:var(--bg2); border-radius:0 6px 6px 0; font-size:12px; line-height:1.6; }
.thread-msg.thread-root { border-left-color:var(--accent); }
.thread-msg-meta { font-size:10px; color:var(--text3); margin-bottom:4px; display:flex; gap:10px; flex-wrap:wrap; }
.thread-msg-cause { font-size:10px; color:var(--text3); font-style:italic; margin-bottom:4px; }
.thread-msg-body { color:var(--text); white-space:pre-wrap; word-break:break-word; }
.presence-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
.presence-active { background:#39d353; }
.presence-warm { background:#ffa657; }
.presence-cold { background:#7d8590; }
.presence-absent { background:#484f58; }
#live-feed-list { max-width:900px; }
.live-msg { padding:10px 14px; border-left:3px solid var(--border2); margin-bottom:6px; background:var(--bg2); border-radius:0 6px 6px 0; font-size:12px; animation:fadeIn 0.3s ease; }
.live-msg.live-new { border-left-color:var(--accent); }
@keyframes fadeIn { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
.live-meta { font-size:10px; color:var(--text3); margin-bottom:4px; display:flex; gap:10px; }
.live-body { color:var(--text); white-space:pre-wrap; word-break:break-word; font-size:11px; max-height:80px; overflow:hidden; }
#live-status { font-size:11px; color:var(--text2); margin-bottom:12px; }
table.peer-table { width:100%; max-width:1000px; border-collapse:collapse; font-size:12px; }
table.peer-table th { color:var(--text2); font-weight:normal; font-size:10px; text-transform:uppercase; letter-spacing:0.05em; padding:6px 10px; border-bottom:1px solid var(--border); text-align:left; }
table.peer-table td { padding:8px 10px; border-bottom:1px solid var(--border2); vertical-align:top; }
table.peer-table tr:hover td { background:var(--bg2); }
.queue-badge { display:inline-block; min-width:20px; text-align:center; padding:1px 5px; border-radius:3px; font-size:10px; font-weight:bold; }
.queue-badge-0 { color:var(--text3); }
.queue-badge-low { background:#ffa65733; color:#ffa657; }
.queue-badge-high { background:#f7816633; color:#f78166; }
#main.matrix-only-layout { display:block; padding:20px 24px; overflow:auto; background:var(--bg); }
#main.matrix-only-layout #heatmap-pane { width:auto; max-width:100%; overflow:visible; padding:0; }
#main.mesh-only-layout #graph-pane { flex:1; width:100%; }
body:not(.view-mesh) #header label { display:none; }
`;

// ── HTML shell ─────────────────────────────────────────────────
export function htmlShell(opts: {
  view: string;
  bodyClass?: string;
  totalMsgs?: number;
  totalAgents?: number;
  totalLinks?: number;
  nodeCount?: number;
  nodeDefault?: number;
  navHtml: string;
  mainHtml: string;
  nodesJson?: string;
  linksJson?: string;
  extraScripts?: TrustedScript;
}): string {
  const {
    view,
    totalMsgs = 0,
    totalAgents = 0,
    totalLinks = 0,
    nodeCount = 0,
    nodeDefault = 0,
    navHtml,
    mainHtml,
    nodesJson = '[]',
    linksJson = '[]',
    extraScripts = '',
  } = opts;
  const bodyClass = opts.bodyClass ?? `view-${view}`;
  const tenantLabel = TENANT ? esc(TENANT) : 'all tenants';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>agent-hub dashboard v2</title>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>
<style>${CSS}</style>
</head>
<body class="${esc(bodyClass)}">

<div id="header" x-data="{ dark: false, driftVal: 3, topN: ${nodeDefault} }">
  <h1>agent-hub v2</h1>
  <div class="stat"><strong>${totalMsgs}</strong>messages</div>
  <div class="stat"><strong>${totalAgents}</strong>agents</div>
  <div class="stat"><strong>${totalLinks}</strong>active links</div>
  <div id="header-right">
    <label style="display:flex;align-items:center;gap:6px;color:var(--text2)"
      @input="driftVal = $event.target.value">
      drift
      <input id="drift-speed" type="range" min="0" max="10" value="3" step="0.5"
        style="width:80px;accent-color:var(--accent);cursor:pointer">
      <span id="drift-val" style="width:2ch;text-align:right" x-text="driftVal">3</span>
    </label>
    <label style="display:flex;align-items:center;gap:6px;color:var(--text2)">
      nodes
      <input id="top-n" type="range" min="1" max="${nodeCount}" value="${nodeDefault}" step="1"
        style="width:80px;accent-color:var(--accent);cursor:pointer"
        @input="topN = parseInt($event.target.value); $dispatch('topn-change', { n: topN })">
      <span id="top-n-val" style="min-width:2ch;text-align:right" x-text="topN">${nodeDefault}</span>
    </label>
    tenant: ${tenantLabel} &nbsp;|&nbsp; reload で最新取得
    <button id="theme-btn"
      @click="dark = !dark; document.body.classList.toggle('dark', dark); $dispatch('theme-changed', { dark })"
      x-text="dark ? '☀️ light' : '🌙 dark'">🌙 dark</button>
  </div>
</div>

${navHtml}

${mainHtml}

<div id="tooltip"></div>

<script type="module">
import { select, selectAll } from 'https://cdn.jsdelivr.net/npm/d3-selection@3/+esm';
import { zoom } from 'https://cdn.jsdelivr.net/npm/d3-zoom@3/+esm';
import { drag } from 'https://cdn.jsdelivr.net/npm/d3-drag@3/+esm';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'https://cdn.jsdelivr.net/npm/d3-force@3/+esm';
import { scaleSqrt, scaleLinear } from 'https://cdn.jsdelivr.net/npm/d3-scale@4/+esm';
import { max } from 'https://cdn.jsdelivr.net/npm/d3-array@3/+esm';
import { color } from 'https://cdn.jsdelivr.net/npm/d3-color@3/+esm';
const roleColor = id => {
  if (id.includes('planner'))    return '#f78166';
  if (id.includes('reviewer'))   return '#ffa657';
  if (id.includes('knowledge'))  return '#7ee787';
  if (id.includes('researcher')) return '#39d353';
  if (id.includes('impl'))       return '#79c0ff';
  if (id.includes('bridge'))     return '#d2a8ff';
  if (id.includes('scheduler'))  return '#ff7b72';
  if (id.includes('writer'))     return '#e3b341';
  if (id.includes('ope-ultp'))   return '#f0883e';
  if (id.includes('admin'))      return '#58a6ff';
  return '#8b949e';
};

const pane = document.getElementById('graph-pane');
if (pane) {
  const allNodesRaw = ${jsonForScript(nodesJson)};
  const allLinksRaw = ${jsonForScript(linksJson)};
  const w = pane.offsetWidth, h = pane.offsetHeight;
  const svg = select('#svg').attr('viewBox', [0, 0, w, h]);
  const defs = svg.append('defs');
  const glow = defs.append('filter').attr('id','glow').attr('x','-50%').attr('y','-50%').attr('width','200%').attr('height','200%');
  glow.append('feGaussianBlur').attr('stdDeviation','4').attr('result','blur');
  const gMerge = glow.append('feMerge');
  gMerge.append('feMergeNode').attr('in','blur');
  gMerge.append('feMergeNode').attr('in','SourceGraphic');
  const edgeGlow = defs.append('filter').attr('id','edge-glow').attr('x','-20%').attr('y','-20%').attr('width','140%').attr('height','140%');
  edgeGlow.append('feGaussianBlur').attr('stdDeviation','1.5').attr('result','blur');
  const egMerge = edgeGlow.append('feMerge');
  egMerge.append('feMergeNode').attr('in','blur');
  egMerge.append('feMergeNode').attr('in','SourceGraphic');
  const g = svg.append('g');
  svg.call(zoom().scaleExtent([0.3, 4]).on('zoom', e => g.attr('transform', e.transform)));
  let currentSim = null;
  function redraw(topN) {
    if (currentSim) currentSim.stop();
    g.selectAll('*').remove();
    const ns = allNodesRaw.slice(0, topN).map(d => ({...d}));
    const nsSet = new Set(ns.map(d => d.id));
    const ls = allLinksRaw.filter(l => nsSet.has(l.source) && nsSet.has(l.target)).map(d => ({...d}));
    defs.selectAll('radialGradient').remove();
    ns.forEach(d => {
      const c = roleColor(d.id);
      const grad = defs.append('radialGradient')
        .attr('id', 'g-' + d.id.replace(/[@-]/g,'_'))
        .attr('cx','35%').attr('cy','35%').attr('r','65%');
      grad.append('stop').attr('offset','0%').attr('stop-color','#fff').attr('stop-opacity','0.35');
      grad.append('stop').attr('offset','50%').attr('stop-color', c).attr('stop-opacity','1');
      grad.append('stop').attr('offset','100%').attr('stop-color', color(c).darker(1.2)).attr('stop-opacity','1');
    });
    const maxTotal = max(ns, d => d.total);
    const maxVal   = max(ls, d => d.value);
    const rScale = scaleSqrt().domain([0, maxTotal || 1]).range([6, 32]);
    const wScale = scaleSqrt().domain([0, maxVal || 1]).range([0.8, 6]);
    const opacityScale = scaleLinear().domain([0, maxVal || 1]).range([0.25, 0.85]);
    currentSim = forceSimulation(ns)
      .force('link', forceLink(ls).id(d => d.id).distance(d => 120 - wScale(d.value) * 3).strength(0.35))
      .force('charge', forceManyBody().strength(-380))
      .force('center', forceCenter(w / 2, h / 2))
      .force('collision', forceCollide().radius(d => rScale(d.total) + 12));
    const link = g.append('g').selectAll('path').data(ls).join('path')
      .attr('fill', 'none')
      .attr('stroke', d => roleColor(d.source.id || d.source))
      .attr('stroke-opacity', d => opacityScale(d.value))
      .attr('stroke-width', d => wScale(d.value))
      .attr('filter', 'url(#edge-glow)');
    const node = g.append('g').selectAll('g').data(ns).join('g')
      .call(drag()
        .on('start', (e, d) => { if (!e.active) currentSim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on('end',   (e, d) => { if (!e.active) currentSim.alphaTarget(0); d.fx = null; d.fy = null; }));
    const diamond = r => \`0,\${-r} \${r},0 0,\${r} \${-r},0\`;
    function addInteraction(sel) {
      sel.on('mouseover', (e, d) => {
          select(e.currentTarget).attr('stroke-opacity', 1).attr('stroke-width', 2);
          const tip = document.getElementById('tooltip');
          const myLinks = ls.filter(l => l.source.id === d.id || l.target.id === d.id);
          const rows = myLinks.sort((a,b) => b.value - a.value).slice(0,6)
            .map(l => { const peer = l.source.id === d.id ? l.target.id : l.source.id; return \`<span style="color:var(--text2)">\${peer}</span>: \${l.value}\`; }).join('<br>');
          const badge = d.team ? ' <span style="font-size:9px;color:#ffa657">[team]</span>' : '';
          tip.innerHTML = \`<strong style="color:var(--accent)">\${d.id}</strong>\${badge}<br>total: \${d.total}<br>\${rows}\`;
          tip.style.display = 'block';
          tip.style.left = (e.pageX + 14) + 'px';
          tip.style.top  = (e.pageY - 10) + 'px';
        })
        .on('mousemove', e => { const tip = document.getElementById('tooltip'); tip.style.left = (e.pageX + 14) + 'px'; tip.style.top = (e.pageY - 10) + 'px'; })
        .on('mouseout', e => { select(e.currentTarget).attr('stroke-opacity', 0.6).attr('stroke-width', 1); document.getElementById('tooltip').style.display = 'none'; });
    }
    node.filter(d => !d.team).append('circle')
      .attr('r', d => rScale(d.total))
      .attr('fill', d => \`url(#g-\${d.id.replace(/[@-]/g,'_')})\`)
      .attr('stroke', d => roleColor(d.id))
      .attr('stroke-width', 1).attr('stroke-opacity', 0.6)
      .attr('filter', 'url(#glow)')
      .call(addInteraction);
    node.filter(d => d.team).append('polygon')
      .attr('points', d => diamond(rScale(d.total) * 1.1))
      .attr('fill', d => \`url(#g-\${d.id.replace(/[@-]/g,'_')})\`)
      .attr('stroke', d => roleColor(d.id))
      .attr('stroke-width', 1.5).attr('stroke-opacity', 0.8)
      .attr('stroke-dasharray', '4 2')
      .attr('filter', 'url(#glow)')
      .call(addInteraction);
    node.append('text')
      .attr('dy', d => rScale(d.total) * (d.team ? 1.2 : 1) + 14)
      .attr('text-anchor', 'middle')
      .attr('font-size', '10px')
      .attr('fill', () => getComputedStyle(document.documentElement).getPropertyValue('--node-text').trim() || '#333')
      .attr('pointer-events', 'none')
      .text(d => d.team ? d.id + ' ◆' : d.id);
    function arcPath(d) {
      const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
      const dx = tx - sx, dy = ty - sy;
      const dr = Math.sqrt(dx*dx + dy*dy) * 1.4;
      return \`M\${sx},\${sy}A\${dr},\${dr} 0 0,1 \${tx},\${ty}\`;
    }
    currentSim.on('tick', () => {
      link.attr('d', arcPath);
      node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
    });
  }
  const speedSlider = document.getElementById('drift-speed');
  let drifting = true;
  setInterval(() => {
    if (!drifting || !currentSim) return;
    const s = parseFloat(speedSlider.value);
    if (s === 0) return;
    currentSim.nodes().forEach(d => {
      if (d.fx != null) return;
      d.vx = (d.vx || 0) + (Math.random() - 0.5) * s * 0.2;
      d.vy = (d.vy || 0) + (Math.random() - 0.5) * s * 0.2;
    });
    currentSim.alpha(Math.max(currentSim.alpha(), s * 0.015)).restart();
  }, 1000);
  svg.on('mousedown', () => { drifting = false; }).on('mouseup', () => { setTimeout(() => { drifting = true; }, 800); });
  const topNSlider = document.getElementById('top-n');
  window.addEventListener('topn-change', e => { redraw(e.detail.n); });
  redraw(parseInt(topNSlider.value, 10));
}

(function() {
  const div = document.getElementById('divider');
  const hm  = document.getElementById('heatmap-pane');
  if (!div || !hm) return;
  let dragging = false, startX = 0, startW = 0;
  div.addEventListener('mousedown', e => { dragging = true; startX = e.clientX; startW = hm.offsetWidth; div.classList.add('dragging'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
  document.addEventListener('mousemove', e => { if (!dragging) return; const delta = startX - e.clientX; const newW = Math.max(200, Math.min(window.innerWidth - 300, startW + delta)); hm.style.width = newW + 'px'; });
  document.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; div.classList.remove('dragging'); document.body.style.cursor = ''; document.body.style.userSelect = ''; });
})();

window.addEventListener('theme-changed', () => {
  const nc = getComputedStyle(document.documentElement).getPropertyValue('--node-text').trim();
  selectAll('text').attr('fill', nc);
});

document.querySelectorAll('td[data-n]').forEach(td => {
  td.title = td.dataset.from + ' → ' + td.dataset.to + ': ' + td.dataset.n + ' msgs';
});
</script>
${extraScripts}
</body>
</html>`;
}

// ── Nav bar ────────────────────────────────────────────────────
export function renderNav(currentView: string, agentHandle?: string): string {
  const bp = BASE_PATH;
  const views = [
    ['mesh', 'Mesh', `${bp}/`],
    ['matrix', 'Matrix', `${bp}/?view=matrix`],
    ['timeline', 'Timeline', `${bp}/?view=timeline`],
    ['links', 'Links', `${bp}/?view=links`],
  ];
  const liveViews = [
    ['live', '📡 Live Feed', `${bp}/?view=live`],
    ['current', '⚡ Current', `${bp}/?view=current`],
  ];
  const drillViews = [
    ['causaltree', 'Causal Tree', `${bp}/?view=causaltree`],
    ['health', '🔥 Health', `${bp}/?view=health`],
  ];

  const link = (key: string, label: string, url: string) =>
    `<a href="${url}" class="${currentView === key ? 'active' : ''}">${label}</a>`;

  const agentUrl = agentHandle ? `${bp}/?agent=${escAttr(agentHandle)}` : `${bp}/?`;
  const agentLink = currentView === 'agent' && agentHandle
    ? `<a class="active" href="${agentUrl}">Agent Detail</a>`
    : agentHandle
    ? `<a href="${agentUrl}">Agent Detail</a>`
    : `<a class="disabled" href="${bp}/" title="Click a handle in Mesh/Links to open Agent Detail">Agent Detail</a>`;

  return `<div id="nav-bar">
  <span class="nav-section-label">Overview</span>
  ${views.map(([k,l,u]) => link(k,l,u)).join('\n  ')}
  <div class="nav-divider"></div>
  <span class="nav-section-label">Live</span>
  ${liveViews.map(([k,l,u]) => link(k,l,u)).join('\n  ')}
  <div class="nav-divider"></div>
  <span class="nav-section-label">Drill-down</span>
  ${drillViews.map(([k,l,u]) => link(k,l,u)).join('\n  ')}
  ${agentLink}
</div>`;
}

// ── Error page ─────────────────────────────────────────────────
export function errorPage(msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>error</title></head>
<body style="font-family:monospace;padding:40px;background:#0d1117;color:#e6edf3">
<h1 style="color:#f78166">Dashboard Error</h1>
<pre style="margin-top:16px;color:#7d8590">${esc(msg)}</pre>
</body></html>`;
}
