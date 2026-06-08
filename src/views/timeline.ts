import { getDb, tenantCond } from '../db.js';
import { htmlShell, renderNav, asTrustedScript } from '../layout.js';
import { BASE_PATH } from '../constants.js';

// ── renderTimeline ─────────────────────────────────────────────
export function renderTimeline(rangeLabel: string): string {
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
    `<a href="${BASE_PATH}/?view=timeline&range=${r}" class="range-btn ${r === rangeLabel ? 'active' : ''}">${r}</a>`
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

  return htmlShell({ view: 'timeline', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, extraScripts: asTrustedScript(extraScripts) });
}
