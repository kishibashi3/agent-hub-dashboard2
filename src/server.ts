import express, { Request, Response } from 'express';
import Database from 'better-sqlite3';

// ── Environment ────────────────────────────────────────────────
const DB_PATH = process.env.AGENT_HUB_DB_PATH ?? '/app/data/app.db';
const TENANT = process.env.AGENT_HUB_TENANT ?? null;
const PORT = parseInt(process.env.PORT ?? '8080', 10);
const STALE_HOURS = parseInt(process.env.AGENT_HUB_DASHBOARD_STALE_HOURS ?? '24', 10);

// ── Health constants ───────────────────────────────────────────
const PPD_THREAD_THRESHOLD = parseInt(process.env.AGENT_HUB_PPD_THREAD_THRESHOLD ?? '5', 10);
const PPD_CRITICAL_THRESHOLD = parseInt(process.env.AGENT_HUB_PPD_CRITICAL_THRESHOLD ?? '10', 10);
const PPD_SEVERE_THRESHOLD = parseInt(process.env.AGENT_HUB_PPD_SEVERE_THRESHOLD ?? '20', 10);

const CDS_HIGH_SIGNALS = ['着手します','実装開始','dispatch','依頼します','依頼しました','お願いします','対応します','PR を作','commit','push','完了しました','完了です','PR を出しました','LGTM','merge しました','マージしました','finished','done','完了','実装しました','調査しました','調査完了','作成しました','ブロックされています','エラーが発生','設計に問題','ブロック','失敗しました','エラー:','エラーが出','問題が発生','障害'];
const CDS_LOW_SIGNALS = ['了解しました','了解です','ありがとうございます','確認しました','承知しました','分かりました','わかりました','受け取りました','待機中','standby','次タスクを待っています','待機します','idle','待ちます','準備完了','ready','はい','OK','ok','nod'];
const CDS_WARNING_THRESHOLD = 50;
const CDS_DANGER_THRESHOLD = 40;

const META_SIGNALS = ['プロセスを変更','手順を見直し','運用を調整','フローを改善','プロセス改善','フロー変更','運用改善','手順変更','ルールを更新','規約を変更','CLAUDE.md を修正','persona を更新','CLAUDE.md を更新','CLAUDE.md に追記','規約を追加','ルール変更','ロールを変更','担当を変更','責務を見直し','役割を変更','担当変更','役割調整','bridge を再起動','respawn','bridge を stop','spawn','bridge 再起動','再起動してください','stop-bridge','start-bridge'];
const MOR_WARNING = 30;
const MOR_DANGER = 40;

const ESCALATION_SIGNALS = ['確認をお願い','判断をお願い','GO をお願い','承認','許可をください','どうしますか','判断してください','エスカレーション','確認お願い','判断お願い'];
const GO_RESPONSE_SIGNALS = ['了解','進めてください','GO','問題ありません','承認します','OK','go ','go\n','GO\n','Go '];
const NON_GO_RESPONSE_SIGNALS = ['待ってください','変更が必要','やり直し','却下','別の方法','確認が必要','設計を見直し','NG','保留','差し戻し'];

// ── Helpers ────────────────────────────────────────────────────
function esc(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escAttr(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtRelative(tsStr: string | null): string {
  if (!tsStr) return '—';
  try {
    const ts = new Date(tsStr).getTime();
    const now = Date.now();
    const s = Math.floor((now - ts) / 1000);
    if (s < 60) return '今';
    if (s < 3600) return `${Math.floor(s/60)}分前`;
    if (s < 86400) return `${Math.floor(s/3600)}時間前`;
    return `${Math.floor(s/86400)}日前`;
  } catch { return '—'; }
}

function computePresence(lastActiveAt: string | null): 'active'|'warm'|'cold'|'absent' {
  if (!lastActiveAt) return 'absent';
  const ageMin = (Date.now() - new Date(lastActiveAt).getTime()) / 60000;
  if (ageMin <= 2) return 'active';
  if (ageMin <= 10) return 'warm';
  if (ageMin <= 60) return 'cold';
  return 'absent';
}

function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: false });
}

function tenantCond(alias = ''): { cond: string; params: unknown[] } {
  if (TENANT === null) return { cond: '', params: [] };
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return { cond: `AND ${col} = ?`, params: [TENANT] };
}

// ── CSS ────────────────────────────────────────────────────────
const CSS = `
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
function htmlShell(opts: {
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
  extraScripts?: string;
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
  const allNodesRaw = ${nodesJson};
  const allLinksRaw = ${linksJson};
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
function renderNav(currentView: string, agentHandle?: string): string {
  const views = [
    ['mesh', 'Mesh', '/'],
    ['matrix', 'Matrix', '/?view=matrix'],
    ['timeline', 'Timeline', '/?view=timeline'],
    ['links', 'Links', '/?view=links'],
  ];
  const liveViews = [
    ['live', '📡 Live Feed', '/?view=live'],
    ['current', '⚡ Current', '/?view=current'],
  ];
  const drillViews = [
    ['causaltree', 'Causal Tree', '/?view=causaltree'],
    ['health', '🔥 Health', '/?view=health'],
  ];

  const link = (key: string, label: string, url: string) =>
    `<a href="${url}" class="${currentView === key ? 'active' : ''}">${label}</a>`;

  const agentUrl = agentHandle ? `/?agent=${escAttr(agentHandle)}` : '/?';
  const agentLink = currentView === 'agent' && agentHandle
    ? `<a class="active" href="${agentUrl}">Agent Detail</a>`
    : agentHandle
    ? `<a href="${agentUrl}">Agent Detail</a>`
    : `<a class="disabled" href="/" title="Click a handle in Mesh/Links to open Agent Detail">Agent Detail</a>`;

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
function errorPage(msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>error</title></head>
<body style="font-family:monospace;padding:40px;background:#0d1117;color:#e6edf3">
<h1 style="color:#f78166">Dashboard Error</h1>
<pre style="margin-top:16px;color:#7d8590">${esc(msg)}</pre>
</body></html>`;
}

// ── getData — Mesh + Matrix ────────────────────────────────────
interface MeshData {
  top: string[];
  counts: Record<string, number>;
  totals: Record<string, number>;
  nodes: { id: string; total: number; team: boolean }[];
  links: { source: string; target: string; value: number }[];
  totalMsgs: number;
  totalAgents: number;
}

function getData(): MeshData {
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

// ── Heatmap HTML ───────────────────────────────────────────────
function buildHeatmap(top: string[], counts: Record<string, number>, totals: Record<string, number>): string {
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

// ── Mesh view ──────────────────────────────────────────────────
function renderMesh(data: MeshData): string {
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

// ── Matrix view ────────────────────────────────────────────────
function renderMatrix(data: MeshData): string {
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

// ── Timeline view ──────────────────────────────────────────────
function renderTimeline(rangeLabel: string): string {
  const db = getDb();
  let buckets: { time: string; count: number }[] = [];
  let agBuckets: { time: string; active: number; idle: number }[] = [];
  let registered = 0;
  let total = 0;
  let totalMsgs = 0;
  let totalAgents = 0;

  try {
    const tc = tenantCond();
    totalMsgs = (db.prepare(`SELECT COUNT(*) FROM messages ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`).pluck().get(...tc.params) as number) ?? 0;
    totalAgents = (db.prepare(`SELECT COUNT(DISTINCT name) FROM participants ${tc.cond ? 'WHERE ' + tc.cond.slice(4) : ''}`).pluck().get(...tc.params) as number) ?? 0;

    let bucketFmt: string;
    let lookback: string;
    if (rangeLabel === '24h') {
      bucketFmt = "%Y-%m-%d %H:00";
      lookback = "datetime('now', '-24 hours')";
    } else if (rangeLabel === '30d') {
      bucketFmt = "%Y-%m-%d";
      lookback = "datetime('now', '-30 days')";
    } else {
      rangeLabel = '7d';
      bucketFmt = "%Y-%m-%d %H:00";
      lookback = "datetime('now', '-7 days')";
    }

    const tWhere = tc.cond ? `tenant_id = ? AND` : '';
    const tParams = tc.params;

    const msgSql = `SELECT strftime('${bucketFmt}', created_at) AS bucket, COUNT(*) AS c
      FROM messages WHERE ${tWhere} datetime(created_at) >= ${lookback}
      GROUP BY bucket ORDER BY bucket ASC`;
    buckets = (db.prepare(msgSql).all(...tParams) as { bucket: string; c: number }[])
      .map(r => ({ time: r.bucket, count: r.c }));
    total = buckets.reduce((s, b) => s + b.count, 0);

    const actSql = `SELECT strftime('${bucketFmt}', created_at) AS bucket, COUNT(DISTINCT sender) AS c
      FROM messages WHERE ${tWhere} datetime(created_at) >= ${lookback}
      GROUP BY bucket ORDER BY bucket ASC`;
    const actRaw = (db.prepare(actSql).all(...tParams) as { bucket: string; c: number }[]);

    const regSql = `SELECT COUNT(*) FROM participants WHERE ${tWhere ? tWhere.slice(0,-4) + ' AND' : ''} deleted_at IS NULL`;
    // rebuild properly
    const regWhere = tc.cond ? `WHERE ${tc.cond.slice(4)} AND deleted_at IS NULL` : `WHERE deleted_at IS NULL`;
    registered = (db.prepare(`SELECT COUNT(*) FROM participants ${regWhere}`).pluck().get(...tParams) as number) ?? 0;

    agBuckets = actRaw.map(r => ({
      time: r.bucket,
      active: r.c,
      idle: Math.max(0, registered - r.c),
    }));
  } finally {
    db.close();
  }

  const rangeBtns = ['24h','7d','30d'].map(r =>
    `<a href="/?view=timeline&range=${r}" class="range-btn ${r === rangeLabel ? 'active' : ''}">${r}</a>`
  ).join(' ');

  const bucketsJson = JSON.stringify(buckets);
  const agBucketsJson = JSON.stringify(agBuckets);

  const navHtml = renderNav('timeline');
  const mainHtml = `<div class="alt-main"><div class="view-content">
<h2>Timeline — message volume over time</h2>
<div class="timeline-controls">
  <span class="dim">range:</span> ${rangeBtns}
  <span class="dim" style="margin-left:20px">total: <strong>${total}</strong> messages in last ${rangeLabel}</span>
</div>
<div id="timeline-chart" style="width:100%;height:400px;margin-top:16px"></div>
<h2 style="margin-top:40px">Timeline — agent activity over time</h2>
<div style="margin-bottom:8px">
  <span class="dim">registered agents (current): <strong>${registered}</strong></span>
  <span style="display:inline-flex;align-items:center;gap:4px;margin-left:16px">
    <span style="display:inline-block;width:12px;height:12px;background:var(--accent);opacity:0.9;border-radius:2px"></span>
    <span class="dim">active (sent msg in bucket)</span>
  </span>
  <span style="display:inline-flex;align-items:center;gap:4px;margin-left:12px">
    <span style="display:inline-block;width:12px;height:12px;background:#888;opacity:0.45;border-radius:2px"></span>
    <span class="dim">idle (registered − active)</span>
  </span>
</div>
<div id="agent-activity-chart" style="width:100%;height:320px;margin-top:8px"></div>
</div></div>`;

  const extraScripts = `<script type="module">
import { select } from 'https://cdn.jsdelivr.net/npm/d3-selection@3/+esm';
import { scaleBand, scaleLinear } from 'https://cdn.jsdelivr.net/npm/d3-scale@4/+esm';
import { max } from 'https://cdn.jsdelivr.net/npm/d3-array@3/+esm';
import { axisLeft, axisBottom } from 'https://cdn.jsdelivr.net/npm/d3-axis@3/+esm';
import { format } from 'https://cdn.jsdelivr.net/npm/d3-format@3/+esm';
const tlBuckets = ${bucketsJson};
const tlContainer = document.getElementById('timeline-chart');
const tlW = tlContainer.offsetWidth, tlH = tlContainer.offsetHeight;
const tlMargin = {top:20,right:30,bottom:60,left:50};
const tlIW = tlW - tlMargin.left - tlMargin.right;
const tlIH = tlH - tlMargin.top - tlMargin.bottom;
const tlSvg = select('#timeline-chart').append('svg').attr('width',tlW).attr('height',tlH)
  .append('g').attr('transform',\`translate(\${tlMargin.left},\${tlMargin.top})\`);
if (tlBuckets.length === 0) {
  tlSvg.append('text').attr('x',tlIW/2).attr('y',tlIH/2).attr('text-anchor','middle')
    .attr('fill',getComputedStyle(document.documentElement).getPropertyValue('--text2').trim())
    .text('No messages in selected range');
} else {
  const tlX = scaleBand().domain(tlBuckets.map(d => d.time)).range([0,tlIW]).padding(0.1);
  const tlY = scaleLinear().domain([0, max(tlBuckets,d=>d.count)||1]).range([tlIH,0]).nice();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  tlSvg.selectAll('.bar').data(tlBuckets).join('rect')
    .attr('x',d=>tlX(d.time)).attr('y',d=>tlY(d.count))
    .attr('width',tlX.bandwidth()).attr('height',d=>tlIH-tlY(d.count))
    .attr('fill',accent).attr('opacity',0.8)
    .append('title').text(d=>\`\${d.time}: \${d.count} msgs\`);
  tlSvg.append('g').call(axisLeft(tlY).ticks(5));
  const tickEvery = Math.max(1,Math.floor(tlBuckets.length/12));
  tlSvg.append('g').attr('transform',\`translate(0,\${tlIH})\`)
    .call(axisBottom(tlX).tickValues(tlBuckets.filter((_,i)=>i%tickEvery===0).map(d=>d.time)))
    .selectAll('text').attr('transform','rotate(-45)').attr('text-anchor','end').attr('dx','-0.5em').attr('dy','0.5em').attr('font-size','10px');
}
const agBuckets = ${agBucketsJson};
const agRegistered = ${registered};
const agContainer = document.getElementById('agent-activity-chart');
const agW = agContainer.offsetWidth, agH = agContainer.offsetHeight;
const agMargin = {top:20,right:80,bottom:60,left:50};
const agIW = agW - agMargin.left - agMargin.right;
const agIH = agH - agMargin.top - agMargin.bottom;
const agSvg = select('#agent-activity-chart').append('svg').attr('width',agW).attr('height',agH)
  .append('g').attr('transform',\`translate(\${agMargin.left},\${agMargin.top})\`);
if (agBuckets.length === 0) {
  agSvg.append('text').attr('x',agIW/2).attr('y',agIH/2).attr('text-anchor','middle')
    .attr('fill',getComputedStyle(document.documentElement).getPropertyValue('--text2').trim())
    .text('No agent activity in selected range');
} else {
  const accent2 = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const agX = scaleBand().domain(agBuckets.map(d=>d.time)).range([0,agIW]).padding(0.1);
  const yMax = Math.max(agRegistered, max(agBuckets,d=>d.active+d.idle)||1);
  const agY = scaleLinear().domain([0,yMax]).range([agIH,0]).nice();
  agSvg.selectAll('.bar-active').data(agBuckets).join('rect').attr('class','bar-active')
    .attr('x',d=>agX(d.time)).attr('y',d=>agY(d.active))
    .attr('width',agX.bandwidth()).attr('height',d=>agIH-agY(d.active))
    .attr('fill',accent2).attr('opacity',0.85)
    .append('title').text(d=>\`\${d.time}\\nactive: \${d.active}\\nidle: \${d.idle}\`);
  agSvg.selectAll('.bar-idle').data(agBuckets).join('rect').attr('class','bar-idle')
    .attr('x',d=>agX(d.time)).attr('y',d=>agY(d.idle+d.active))
    .attr('width',agX.bandwidth()).attr('height',d=>agY(d.active)-agY(d.idle+d.active))
    .attr('fill','#888').attr('opacity',0.35)
    .append('title').text(d=>\`\${d.time}\\nactive: \${d.active}\\nidle: \${d.idle}\`);
  if (agRegistered > 0) {
    agSvg.append('line').attr('x1',0).attr('x2',agIW).attr('y1',agY(agRegistered)).attr('y2',agY(agRegistered))
      .attr('stroke','#aaa').attr('stroke-dasharray','4,3').attr('stroke-width',1);
    agSvg.append('text').attr('x',agIW+4).attr('y',agY(agRegistered)+4).attr('font-size','10px')
      .attr('fill',getComputedStyle(document.documentElement).getPropertyValue('--text2').trim())
      .text(\`registered (\${agRegistered})\`);
  }
  agSvg.append('g').call(axisLeft(agY).ticks(Math.min(yMax,6)).tickFormat(format('d')));
  const agTickEvery = Math.max(1,Math.floor(agBuckets.length/12));
  agSvg.append('g').attr('transform',\`translate(0,\${agIH})\`)
    .call(axisBottom(agX).tickValues(agBuckets.filter((_,i)=>i%agTickEvery===0).map(d=>d.time)))
    .selectAll('text').attr('transform','rotate(-45)').attr('text-anchor','end').attr('dx','-0.5em').attr('dy','0.5em').attr('font-size','10px');
}
</script>`;

  return htmlShell({ view: 'timeline', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, extraScripts });
}

// ── Links view ─────────────────────────────────────────────────
function renderLinks(): string {
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
    ).all(...tc.params) as [string, string, number][];

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
  <td><a href="/?agent=${escAttr(link.a)}">${esc(link.a)}</a> &nbsp;↔&nbsp; <a href="/?agent=${escAttr(link.b)}">${esc(link.b)}</a></td>
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

  return htmlShell({ view: 'links', totalMsgs, totalAgents, totalLinks: items.length, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml });
}

// ── Agent Detail view ──────────────────────────────────────────
function renderAgent(handle: string): string {
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
          `<li><a href="/?agent=${escAttr(p.peer)}">${esc(p.peer)}</a> <span class="dim">${p.count} msgs</span></li>`
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

// ── Current view ───────────────────────────────────────────────
function renderCurrent(): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;

  interface Peer { name: string; displayName: string | null; lastActiveAt: string | null; queueDepth: number; presence: string; currentTaskId: string | null; currentTaskPreview: string; }
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

    // latest root per participant
    const latestRoots = db.prepare(
      `SELECT m.recipient, mc.root_message_id, m.created_at
       FROM messages m
       JOIN message_causes mc ON mc.tenant_id=m.tenant_id AND mc.message_id=m.id
       WHERE mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
       ORDER BY m.recipient, m.created_at DESC`
    ).all(...tParams) as { recipient: string; root_message_id: string; created_at: string }[];
    const latestRootMap: Record<string, string> = {};
    for (const r of latestRoots) {
      if (!latestRootMap[r.recipient]) latestRootMap[r.recipient] = r.root_message_id;
    }

    // root message previews
    const rootPreviews: Record<string, string> = {};
    const rootIds = [...new Set(Object.values(latestRootMap))];
    for (const rootId of rootIds) {
      const msg = db.prepare(`SELECT body FROM messages WHERE id = ? ${tAnd} LIMIT 1`).get(rootId, ...tParams) as { body: string } | undefined;
      if (msg) rootPreviews[rootId] = msg.body.slice(0, 60);
    }

    peers = peerRows.map(p => ({
      name: p.name,
      displayName: p.display_name,
      lastActiveAt: p.last_active_at,
      queueDepth: queueMap[p.name] ?? 0,
      presence: computePresence(p.last_active_at),
      currentTaskId: latestRootMap[p.name] ?? null,
      currentTaskPreview: latestRootMap[p.name] ? (rootPreviews[latestRootMap[p.name]] ?? '') : '',
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
    const taskLink = p.currentTaskId
      ? `<a href="/?view=causaltree&thread=${escAttr(p.currentTaskId)}" style="color:var(--text2);font-size:11px">${esc(p.currentTaskPreview || p.currentTaskId.slice(0,8)+'…')}</a>`
      : `<span style="color:var(--text3);font-size:11px">—</span>`;
    const dispName = p.displayName && p.displayName !== p.name ? ` <span style="font-size:10px;color:var(--text2)">${esc(p.displayName)}</span>` : '';
    return `<tr>
  <td><a href="/?agent=${escAttr(p.name)}" style="color:var(--accent);text-decoration:none">${esc(p.name)}</a>${dispName}</td>
  <td><span class="presence-dot presence-${esc(p.presence)}"></span>${esc(p.presence)}</td>
  <td>${queueBadge(p.queueDepth)}</td>
  <td>${taskLink}</td>
  <td style="font-size:11px;color:var(--text3)">${fmtRelative(p.lastActiveAt)}</td>
</tr>`;
  }).join('');

  const taskRows2 = tasks.map(t =>
    `<tr>
  <td><a href="/?view=causaltree&thread=${escAttr(t.rootId)}">${esc(t.rootId.slice(0,8))}…</a><br>
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

  return htmlShell({ view: 'current', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml });
}

// ── Health view ────────────────────────────────────────────────
function renderHealth(): string {
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
       HAVING thread_size >= ${PPD_THREAD_THRESHOLD}
       ORDER BY thread_size DESC
       LIMIT 50`
    ).all(...(tAnd ? [...tParams, ...tParams] : [])) as { root_message_id: string; thread_size: number; first_ts: string | null; last_ts: string | null }[];

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

    const msgById: Record<string, typeof allMsgs[0]> = {};
    for (const m of allMsgs) msgById[m.id] = m;

    // For each escalation, find subsequent in thread
    const escalationMsgs = allMsgs.filter(m => ESCALATION_SIGNALS.some(s => m.body.includes(s)));
    eqsTotal = escalationMsgs.length;

    for (const esc_msg of escalationMsgs.slice(0, 100)) {
      // find root for this message
      const mcRow = db.prepare(`SELECT root_message_id FROM message_causes WHERE message_id=? AND position=0 ${tAnd} LIMIT 1`).get(esc_msg.id, ...tParams) as { root_message_id: string } | undefined;
      let response = 'unanswered';
      if (mcRow) {
        // find messages in same thread after this one
        const threadMsgs = db.prepare(
          `SELECT m.body, m.created_at FROM messages m
           JOIN message_causes mc ON mc.message_id=m.id AND mc.position=0 ${tAnd ? tAnd.replace('AND tenant_id', 'AND mc.tenant_id') : ''}
           WHERE mc.root_message_id=? AND m.created_at > ? ${tAnd ? tAnd.replace('AND tenant_id', 'AND m.tenant_id') : ''}
           ORDER BY m.created_at ASC LIMIT 10`
        ).all(mcRow.root_message_id, esc_msg.created_at, ...(tAnd ? [...tParams, ...tParams] : [])) as { body: string }[];
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
  <td><a href="/?view=causaltree&thread=${escAttr(t.rootId)}">${esc(t.rootId.slice(0,8))}…</a></td>
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

  return htmlShell({ view: 'health', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml });
}

// ── Causal Tree view ───────────────────────────────────────────
function renderCausalTree(threadId?: string, filterAgent?: string, filterFrom?: string, filterTo?: string): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;

  interface ThreadRow { rootId: string; size: number; start: string | null; end: string | null; }
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
      extraParams.push(filterAgent, filterAgent, ...(tAnd ? [...tParams, ...tParams] : []));
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

// ── Live Feed view ─────────────────────────────────────────────
function renderLive(): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;
  try {
    const tc = tenantCond();
    const tWhere = tc.cond ? 'WHERE ' + tc.cond.slice(4) : '';
    totalMsgs = (db.prepare(`SELECT COUNT(*) FROM messages ${tWhere}`).pluck().get(...tc.params) as number) ?? 0;
    totalAgents = (db.prepare(`SELECT COUNT(DISTINCT name) FROM participants ${tWhere}`).pluck().get(...tc.params) as number) ?? 0;
  } finally {
    db.close();
  }

  const navHtml = renderNav('live');
  const mainHtml = `<div class="alt-main"><div class="view-content">
<h2>📡 Live Feed</h2>
<div id="live-status">connecting...</div>
<div id="live-feed-list"></div>
</div></div>`;

  const extraScripts = `<script>
const es = new EventSource('/sse/live');
const list = document.getElementById('live-feed-list');
const status = document.getElementById('live-status');
es.onopen = () => { status.textContent = '● connected — watching all messages'; status.style.color='#39d353'; };
es.onmessage = e => {
  const msgs = JSON.parse(e.data);
  msgs.forEach(m => {
    const div = document.createElement('div');
    div.className = 'live-msg live-new';
    const ts = m.created_at.replace('T',' ').slice(0,19)+'Z';
    div.innerHTML = '<div class="live-meta"><span style="color:var(--accent)">' + escH(m.sender) + '</span><span>→</span><span>' + escH(m.recipient) + '</span><span style="margin-left:auto">' + ts + '</span></div><div class="live-body">' + escH((m.body||'').slice(0,200)) + '</div>';
    list.insertBefore(div, list.firstChild);
    setTimeout(() => div.classList.remove('live-new'), 1000);
    while (list.children.length > 100) list.removeChild(list.lastChild);
  });
};
es.onerror = () => { status.textContent = '✗ disconnected — retrying...'; status.style.color='#f78166'; };
function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>`;

  return htmlShell({ view: 'live', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, extraScripts });
}

// ── getLiveFeedData ────────────────────────────────────────────
interface LiveMsg { id: string; sender: string; recipient: string; body: string; created_at: string; }
function getLiveFeedData(db: Database.Database, since?: string): LiveMsg[] {
  const tc = tenantCond();
  const tAnd = tc.cond;
  const tParams = tc.params;
  if (since) {
    return db.prepare(
      `SELECT id, sender, recipient, body, created_at FROM messages WHERE created_at > ? ${tAnd} ORDER BY created_at DESC LIMIT 100`
    ).all(since, ...tParams) as LiveMsg[];
  }
  const tWhere = tAnd ? 'WHERE ' + tAnd.slice(4) : '';
  return db.prepare(
    `SELECT id, sender, recipient, body, created_at FROM messages ${tWhere} ORDER BY created_at DESC LIMIT 100`
  ).all(...tParams) as LiveMsg[];
}

// ── Express app ────────────────────────────────────────────────
const app = express();

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

app.get('/sse/live', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let lastId = req.query.since as string | undefined;

  const send = () => {
    try {
      const db = getDb();
      const msgs = getLiveFeedData(db, lastId);
      db.close();
      if (msgs.length > 0) {
        lastId = msgs[0].created_at;
        res.write(`data: ${JSON.stringify(msgs)}\n\n`);
      } else {
        res.write(': heartbeat\n\n');
      }
    } catch (err) {
      res.write(': error\n\n');
    }
  };

  send();
  const interval = setInterval(send, 3000);
  req.on('close', () => clearInterval(interval));
});

app.get('/', (req: Request, res: Response) => {
  const agent = req.query.agent as string | undefined;
  const rawView = req.query.view as string | undefined;
  const view = rawView ?? (agent ? 'agent' : 'mesh');
  const thread = req.query.thread as string | undefined;
  const range = (req.query.range as string) ?? '7d';
  const filterAgent = req.query.agent_filter as string | undefined;
  const filterFrom = req.query.from as string | undefined;
  const filterTo = req.query.to as string | undefined;

  try {
    let html: string;
    switch (view) {
      case 'mesh': {
        const data = getData();
        html = renderMesh(data);
        break;
      }
      case 'matrix': {
        const data = getData();
        html = renderMatrix(data);
        break;
      }
      case 'timeline':
        html = renderTimeline(range);
        break;
      case 'links':
        html = renderLinks();
        break;
      case 'agent':
        if (!agent) {
          res.redirect('/?view=mesh');
          return;
        }
        html = renderAgent(agent);
        break;
      case 'current':
        html = renderCurrent();
        break;
      case 'health':
        html = renderHealth();
        break;
      case 'causaltree':
        html = renderCausalTree(thread, filterAgent, filterFrom, filterTo);
        break;
      case 'live':
        html = renderLive();
        break;
      default:
        html = renderMesh(getData());
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error('Dashboard error:', msg);
    res.status(500).send(errorPage(msg));
  }
});

app.listen(PORT, () => {
  console.log(`agent-hub dashboard v2 listening on http://0.0.0.0:${PORT}`);
  console.log(`  DB: ${DB_PATH}`);
  console.log(`  Tenant: ${TENANT ?? '(all)'}`);
  console.log(`  Stale hours: ${STALE_HOURS}`);
});
