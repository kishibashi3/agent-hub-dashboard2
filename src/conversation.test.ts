// エージェント・向き・相手の絞り込み (src/conversation.ts) の unit test (issue #33 3b)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getConversation, getConversationSince, parseDirection, listHandles } from './conversation.js';

const T = 'kaz';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (tenant_id TEXT, id TEXT, sender TEXT, recipient TEXT, body TEXT, created_at TEXT);
    CREATE TABLE participants (tenant_id TEXT, name TEXT);
    CREATE TABLE teams (tenant_id TEXT, name TEXT);
  `);
  const ins = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)');
  const rows: [string, string, string, string][] = [
    ['m1', '@planner', '@coder', '2026-11-26T00:00:01.000Z'],
    ['m2', '@coder', '@planner', '2026-11-26T00:00:02.000Z'],
    ['m3', '@planner', '@reviewer', '2026-11-26T00:00:03.000Z'],
    ['m4', '@reviewer', '@planner', '2026-11-26T00:00:04.000Z'],
    ['m5', '@coder', '@team-x', '2026-11-26T00:00:05.000Z'],
    ['m6', '@ope', '@*', '2026-11-26T00:00:06.000Z'],
  ];
  for (const [id, s, r, t] of rows) ins.run(T, id, s, r, `long body of ${id}\n` + 'x'.repeat(500), t);
  ins.run('other', 'o1', '@planner', '@coder', 'other tenant', '2026-11-26T00:00:07.000Z');
  return db;
}

const ids = (ms: { id: string }[]) => ms.map(m => m.id);

test('from: その agent が送った便だけ、新しい順', () => {
  const db = makeDb();
  assert.deepEqual(ids(getConversation(db, T, { agent: '@planner', dir: 'from' }, 100)), ['m3', 'm1']);
});

test('to: その agent が受け取った便だけ', () => {
  const db = makeDb();
  assert.deepEqual(ids(getConversation(db, T, { agent: '@planner', dir: 'to' }, 100)), ['m4', 'm2']);
});

test('both: 送受信両方', () => {
  const db = makeDb();
  assert.deepEqual(ids(getConversation(db, T, { agent: '@planner', dir: 'both' }, 100)), ['m4', 'm3', 'm2', 'm1']);
});

test('peer 指定: from は agent→peer、to は peer→agent、both は 2 者間 (get_history DM と同じ集合)', () => {
  const db = makeDb();
  assert.deepEqual(ids(getConversation(db, T, { agent: '@planner', dir: 'from', peer: '@reviewer' }, 100)), ['m3']);
  assert.deepEqual(ids(getConversation(db, T, { agent: '@planner', dir: 'to', peer: '@reviewer' }, 100)), ['m4']);
  assert.deepEqual(ids(getConversation(db, T, { agent: '@planner', dir: 'both', peer: '@coder' }, 100)), ['m2', 'm1']);
});

test('team 宛は recipient が team 名のときだけ当たる', () => {
  const db = makeDb();
  assert.deepEqual(ids(getConversation(db, T, { agent: '@team-x', dir: 'to' }, 100)), ['m5']);
  assert.deepEqual(ids(getConversation(db, T, { agent: '@coder', dir: 'to' }, 100)), ['m1']);
});

test('本文は切らない', () => {
  const db = makeDb();
  const [m] = getConversation(db, T, { agent: '@planner', dir: 'from', peer: '@coder' }, 100);
  assert.equal(m.body.length, 'long body of m1\n'.length + 500);
});

test('since: cursor より後の便だけ、同時刻は id で区切る', () => {
  const db = makeDb();
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(T, 'm4b', '@coder', '@planner', 'b', '2026-11-26T00:00:04.000Z');
  const got = getConversationSince(db, T, { agent: '@planner', dir: 'to' }, { created_at: '2026-11-26T00:00:04.000Z', id: 'm4' }, 100);
  assert.deepEqual(ids(got), ['m4b']);
  const fromEmpty = getConversationSince(db, T, { agent: '@planner', dir: 'to' }, { created_at: '', id: '' }, 100);
  assert.deepEqual(ids(fromEmpty), ['m4b', 'm4', 'm2']);
});

test('parseDirection: 不正値は both', () => {
  assert.equal(parseDirection('from'), 'from');
  assert.equal(parseDirection('to'), 'to');
  assert.equal(parseDirection('x'), 'both');
  assert.equal(parseDirection(undefined), 'both');
});

test('listHandles: tenant の participants と teams', () => {
  const db = makeDb();
  db.prepare('INSERT INTO participants VALUES (?,?)').run(T, '@planner');
  db.prepare('INSERT INTO participants VALUES (?,?)').run('other', '@zzz');
  db.prepare('INSERT INTO teams VALUES (?,?)').run(T, '@team-x');
  assert.deepEqual(listHandles(db, T), { participants: ['@planner'], teams: ['@team-x'] });
});
