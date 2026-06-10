import Database from 'better-sqlite3';
import { getDb, tenantCond } from '../db.js';
import { htmlShell, renderNav, asTrustedScript } from '../layout.js';
import { BASE_PATH } from '../constants.js';

// ── LiveMsg ────────────────────────────────────────────────────
export interface LiveMsg { id: string; sender: string; recipient: string; body: string; created_at: string; }

// ── getLiveFeedData ────────────────────────────────────────────
export function getLiveFeedData(db: Database.Database, since?: string): LiveMsg[] {
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

// ── renderLive ─────────────────────────────────────────────────
export function renderLive(): string {
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
const list = document.getElementById('live-feed-list');
const status = document.getElementById('live-status');
let lastSeen = '';
let es = null;
let retryTimer = null;

function connect() {
  if (es) { es.onopen = es.onmessage = es.onerror = null; es.close(); }
  const url = lastSeen ? '${BASE_PATH}/sse/live?since=' + encodeURIComponent(lastSeen) : '${BASE_PATH}/sse/live';
  es = new EventSource(url);
  es.onopen = () => { status.textContent = '● connected — watching all messages'; status.style.color='#39d353'; };
  es.onmessage = e => {
    const msgs = JSON.parse(e.data);
    msgs.forEach(m => {
      if (!lastSeen || m.created_at > lastSeen) lastSeen = m.created_at;
      const div = document.createElement('div');
      div.className = 'live-msg live-new';
      const ts = m.created_at.replace('T',' ').slice(0,19)+'Z';
      div.innerHTML = '<div class="live-meta"><span style="color:var(--accent)">' + escH(m.sender) + '</span><span>→</span><span>' + escH(m.recipient) + '</span><span style="margin-left:auto">' + escH(ts) + '</span></div><div class="live-body">' + escH((m.body||'').slice(0,200)) + '</div>';
      list.insertBefore(div, list.firstChild);
      setTimeout(() => div.classList.remove('live-new'), 1000);
      while (list.children.length > 100) list.removeChild(list.lastChild);
    });
  };
  es.onerror = () => {
    status.textContent = '✗ disconnected — retrying...'; status.style.color='#f78166';
    es.close();
    retryTimer = setTimeout(connect, 3000);
  };
}
connect();
function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>`;

  return htmlShell({ view: 'live', totalMsgs, totalAgents, totalLinks: 0, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, extraScripts: asTrustedScript(extraScripts) });
}
