// エージェントを選んで、その便を読む (issue #33 3b rev.4)。
//
// 絞り込みは messages.sender / messages.recipient の文字どおりの一致だけで行う
// (get_history の DM 分岐と同じ見方)。team 宛・@* 宛の便は、recipient が
// その team 名・@* のときだけ当たる (メンバー個人の「to」には展開しない)。
//
//   dir=from : sender = agent            (peer 指定時は recipient = peer も)
//   dir=to   : recipient = agent         (peer 指定時は sender = peer も)
//   dir=both : sender = agent または recipient = agent
//              (peer 指定時は agent と peer の間の便、向きは問わない)
import Database from 'better-sqlite3';

export type Direction = 'from' | 'to' | 'both';

export interface ConvoMsg {
  id: string;
  sender: string;
  recipient: string;
  body: string;
  created_at: string;
}

export interface ConvoFilter {
  agent: string;
  dir: Direction;
  peer?: string;
}

/** ブラウザから来る値を正規化する。不正な向きは 'both' に寄せる。 */
export function parseDirection(raw: unknown): Direction {
  return raw === 'from' || raw === 'to' ? raw : 'both';
}

function whereFor(f: ConvoFilter): { sql: string; params: string[] } {
  const { agent, dir, peer } = f;
  if (dir === 'from') {
    return peer
      ? { sql: 'sender = ? AND recipient = ?', params: [agent, peer] }
      : { sql: 'sender = ?', params: [agent] };
  }
  if (dir === 'to') {
    return peer
      ? { sql: 'recipient = ? AND sender = ?', params: [agent, peer] }
      : { sql: 'recipient = ?', params: [agent] };
  }
  return peer
    ? { sql: '((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))', params: [agent, peer, peer, agent] }
    : { sql: '(sender = ? OR recipient = ?)', params: [agent, agent] };
}

/** 条件に合う便のうち新しい方から limit 件を、新しい順で返す。 */
export function getConversation(db: Database.Database, tenantId: string, f: ConvoFilter, limit: number): ConvoMsg[] {
  const w = whereFor(f);
  return db.prepare(
    `SELECT id, sender, recipient, body, created_at FROM messages
     WHERE tenant_id = ? AND ${w.sql}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(tenantId, ...w.params, limit) as ConvoMsg[];
}

/** cursor (created_at, id) より後に入った便を、新しい順で返す。 */
export function getConversationSince(
  db: Database.Database, tenantId: string, f: ConvoFilter,
  cursor: { created_at: string; id: string }, limit: number,
): ConvoMsg[] {
  const w = whereFor(f);
  return db.prepare(
    `SELECT id, sender, recipient, body, created_at FROM messages
     WHERE tenant_id = ? AND ${w.sql}
       AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(tenantId, ...w.params, cursor.created_at, cursor.created_at, cursor.id, limit) as ConvoMsg[];
}

/** 選べる handle (participants と teams)。 */
export function listHandles(db: Database.Database, tenantId: string): { participants: string[]; teams: string[] } {
  const participants = db.prepare('SELECT name FROM participants WHERE tenant_id = ? ORDER BY name').pluck().all(tenantId) as string[];
  const teams = db.prepare('SELECT name FROM teams WHERE tenant_id = ? ORDER BY name').pluck().all(tenantId) as string[];
  return { participants, teams };
}
