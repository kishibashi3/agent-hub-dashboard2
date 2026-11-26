// エージェントを選んで、その便を読む view (issue #33 3b rev.4)。
// 絞り込みの決まりは src/conversation.ts を参照。
//
// URL に載るのは handle (agent / peer) と向き (dir) だけ。便は SSE
// (/sse/conversation) で受け取り、本文は DOM にだけ入れる。
import { getDb, tenantCond } from '../db.js';
import { esc, escAttr } from '../utils.js';
import { htmlShell, renderNav, asTrustedScript } from '../layout.js';
import { TENANT } from '../constants.js';
import { listHandles, type Direction } from '../conversation.js';

/** 最初に出す便の件数 (新しい方から)。 */
export const CONVO_INITIAL_LIMIT = 200;

const DIR_LABEL: Record<Direction, string> = {
  from: 'from (送った便)',
  to: 'to (受け取った便)',
  both: '両方',
};

export function renderConversation(prefix: string, totalLinks: number, agent: string | undefined, dir: Direction, peer: string | undefined): string {
  const db = getDb();
  let totalMsgs = 0;
  let totalAgents = 0;
  let handles: { participants: string[]; teams: string[] };
  try {
    const tc = tenantCond();
    const tWhere = tc.cond ? 'WHERE ' + tc.cond.slice(4) : '';
    totalMsgs = (db.prepare(`SELECT COUNT(*) FROM messages ${tWhere}`).pluck().get(...tc.params) as number) ?? 0;
    totalAgents = (db.prepare(`SELECT COUNT(DISTINCT name) FROM participants ${tWhere}`).pluck().get(...tc.params) as number) ?? 0;
    handles = listHandles(db, TENANT);
  } finally {
    db.close();
  }

  const known = new Set([...handles.participants, ...handles.teams]);
  const agentOk = !!agent && known.has(agent);
  const peerOk = !peer || known.has(peer);

  const options = (selected: string | undefined) => {
    const opt = (h: string) => `<option value="${escAttr(h)}"${h === selected ? ' selected' : ''}>${esc(h)}</option>`;
    return `<optgroup label="participants">${handles.participants.map(opt).join('')}</optgroup>`
      + (handles.teams.length ? `<optgroup label="teams">${handles.teams.map(opt).join('')}</optgroup>` : '');
  };
  const dirRadio = (d: Direction) =>
    `<label><input type="radio" name="dir" value="${d}"${d === dir ? ' checked' : ''}> ${DIR_LABEL[d]}</label>`;

  const form = `<form class="ct-filter-bar" method="get" action=".">
  <input type="hidden" name="view" value="conversation">
  <label>エージェント: <select name="agent"><option value="">(選ぶ)</option>${options(agentOk ? agent : undefined)}</select></label>
  ${dirRadio('from')} ${dirRadio('to')} ${dirRadio('both')}
  <label>相手: <select name="peer"><option value="">(誰でも)</option>${options(peerOk ? peer : undefined)}</select></label>
  <button type="submit" class="ct-filter-apply">表示</button>
</form>`;

  let body: string;
  let extraScripts = '';
  if (!agent) {
    body = `<p class="dim">エージェントと向きを選んでください。</p>`;
  } else if (!agentOk || !peerOk) {
    body = `<p style="color:#f78166">選んだ handle がこの tenant にありません。</p>`;
  } else {
    const cond = peer
      ? `${esc(agent)} ${dir === 'from' ? '→' : dir === 'to' ? '←' : '⇄'} ${esc(peer)}`
      : `${esc(agent)} · ${esc(DIR_LABEL[dir])}`;
    body = `<p class="dim" style="margin-bottom:12px">${cond} · 新しい順 · 最初は新しい方から ${CONVO_INITIAL_LIMIT} 件 · 新しい便は 3 秒ごとに追加</p>
<div id="convo-status">connecting...</div>
<div id="convo-count" class="dim"></div>
<div id="convo-list"></div>`;
    const qs = new URLSearchParams({ agent, dir });
    if (peer) qs.set('peer', peer);
    // qs には handle と向きしか入らない。本文は SSE で受け取り textContent で入れる。
    extraScripts = `<script>
(function () {
  var list = document.getElementById('convo-list');
  var status = document.getElementById('convo-status');
  var count = document.getElementById('convo-count');
  function el(tag, cls, text, style) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (style) e.setAttribute('style', style);
    return e;
  }
  function row(m, fresh) {
    var div = el('div', 'live-msg' + (fresh ? ' live-new' : ''));
    var meta = el('div', 'live-meta');
    meta.appendChild(el('span', null, m.sender, 'color:var(--accent)'));
    meta.appendChild(el('span', null, '→'));
    meta.appendChild(el('span', null, m.recipient));
    meta.appendChild(el('span', null, m.created_at.replace('T', ' ').slice(0, 19) + 'Z', 'margin-left:auto'));
    div.appendChild(meta);
    div.appendChild(el('div', 'live-body', m.body || '', 'white-space:pre-wrap;word-break:break-word'));
    if (fresh) setTimeout(function () { div.classList.remove('live-new'); }, 1000);
    return div;
  }
  var es = new EventSource('sse/conversation?' + ${JSON.stringify(qs.toString())});
  es.onopen = function () { status.textContent = '● connected'; status.style.color = '#39d353'; };
  es.onmessage = function (e) {
    var data = JSON.parse(e.data);
    if (data.reset) list.textContent = '';
    // msgs は新しい順。新しいものが先頭に来るよう古い方から先頭に差し込む。
    for (var i = data.msgs.length - 1; i >= 0; i--) list.insertBefore(row(data.msgs[i], !data.reset), list.firstChild);
    count.textContent = list.children.length + ' 件表示中';
  };
  es.onerror = function () { status.textContent = '✗ disconnected — retrying...'; status.style.color = '#f78166'; };
})();
</script>`;
  }

  const navHtml = renderNav('conversation');
  const mainHtml = `<div class="alt-main"><div class="view-content">
<h2>💬 Conversation</h2>
${form}
${body}
</div></div>`;

  return htmlShell({ view: 'conversation', totalMsgs, totalAgents, totalLinks, nodeCount: 0, nodeDefault: 0, navHtml, mainHtml, extraScripts: asTrustedScript(extraScripts), prefix });
}
