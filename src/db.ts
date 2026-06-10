import Database from 'better-sqlite3';
import { DB_PATH, DASHBOARD_DATA_DB_PATH, TENANT } from './constants.js';

export function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: false });
}

export function tenantCond(alias = ''): { cond: string; params: unknown[] } {
  if (TENANT === null) return { cond: '', params: [] };
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return { cond: `AND ${col} = ?`, params: [TENANT] };
}

// ── Dashboard-data DB (writable, thread status) ─────────────────

export type ThreadStatus = 'running' | 'done' | 'stash';

interface StatusRow {
  root_message_id: string;
  tenant_id: string;
  status: ThreadStatus;
  updated_at: string;
  note: string | null;
  updated_by: string | null;
}

let _dataDb: Database.Database | null = null;

function getDataDb(): Database.Database {
  if (!_dataDb) {
    _dataDb = new Database(DASHBOARD_DATA_DB_PATH);
    _dataDb.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_thread_status (
        root_message_id TEXT NOT NULL,
        tenant_id       TEXT NOT NULL DEFAULT 'default',
        status          TEXT NOT NULL,
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        note            TEXT,
        updated_by      TEXT,
        PRIMARY KEY (root_message_id, tenant_id)
      )
    `);
  }
  return _dataDb;
}

export function loadThreadStatuses(): Map<string, StatusRow> {
  try {
    const db = getDataDb();
    const rows = db.prepare('SELECT root_message_id, tenant_id, status, updated_at, note, updated_by FROM dashboard_thread_status').all() as StatusRow[];
    const map = new Map<string, StatusRow>();
    for (const r of rows) map.set(`${r.root_message_id}::${r.tenant_id}`, r);
    return map;
  } catch {
    return new Map();
  }
}

export function effectiveStatus(
  rootId: string,
  tenantId: string,
  threadEnd: string | null,
  statusMap: Map<string, StatusRow>,
): ThreadStatus {
  const key = `${rootId}::${tenantId}`;
  const row = statusMap.get(key);
  if (row) {
    // auto-revert: done/stash 後に新メッセージが来たら running に戻す（read-time only）
    if ((row.status === 'done' || row.status === 'stash') && threadEnd && row.updated_at) {
      if (new Date(threadEnd) > new Date(row.updated_at)) return 'running';
    }
    return row.status;
  }
  const nowMs = Date.now();
  const endMs = threadEnd ? new Date(threadEnd).getTime() : 0;
  return nowMs - endMs < 60 * 60 * 1000 ? 'running' : 'done';
}

export function setThreadStatus(rootId: string, tenantId: string, status: ThreadStatus, updatedBy?: string): void {
  const db = getDataDb();
  db.prepare(`
    INSERT INTO dashboard_thread_status (root_message_id, tenant_id, status, updated_at, updated_by)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
    ON CONFLICT(root_message_id, tenant_id) DO UPDATE SET
      status     = excluded.status,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(rootId, tenantId || 'default', status, updatedBy ?? null);
}
