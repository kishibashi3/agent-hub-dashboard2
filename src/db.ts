import Database from 'better-sqlite3';
import { DB_PATH, DASHBOARD_DATA_DB_PATH, TENANT, STALE_HOURS } from './constants.js';

export function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: false });
}

export function tenantCond(alias = ''): { cond: string; params: unknown[] } {
  if (TENANT === null) return { cond: '', params: [] };
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return { cond: `AND ${col} = ?`, params: [TENANT] };
}

// ── Thread status (faithful port of v1 dashboard server.py) ─────
//
// Mirrors v1's `ensure_thread_status_table` / `load_thread_statuses` /
// `effective_status` / `set_thread_status`. The dashboard persists explicit
// done/stash/running marks in its OWN writable DB (dashboard_data.db), never
// in the read-only hub app.db. Effective status is computed at read-time and
// is one of four states — running / stale / done / stash — exactly as v1.

/** Statuses that can be explicitly stored / set via the mark UI. */
export type ThreadStatus = 'running' | 'done' | 'stash';
/** Read-time effective status: stored statuses plus the derived 'stale'. */
export type EffectiveStatus = ThreadStatus | 'stale';

interface StatusRow {
  root_message_id: string;
  tenant_id: string;
  status: ThreadStatus;
  updated_at: string;
  note: string | null;
  updated_by: string | null;
}

let _dataDb: Database.Database | null = null;

/**
 * Lazily open (and create if absent) the dashboard-owned writable DB and ensure
 * the dashboard_thread_status table exists. Mirrors v1 ensure_thread_status_table.
 */
function getDataDb(): Database.Database {
  if (!_dataDb) {
    const db = new Database(DASHBOARD_DATA_DB_PATH);
    db.exec(`
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
    _dataDb = db;
  }
  return _dataDb;
}

/**
 * Bulk-load all persisted thread statuses into a Map keyed by
 * `${root_message_id}::${tenant_id}`. Mirrors v1 load_thread_statuses; returns
 * an empty Map on any error (e.g. DB not yet writable) so the view still renders.
 */
export function loadThreadStatuses(): Map<string, StatusRow> {
  try {
    const rows = getDataDb()
      .prepare('SELECT root_message_id, tenant_id, status, updated_at, note, updated_by FROM dashboard_thread_status')
      .all() as StatusRow[];
    const map = new Map<string, StatusRow>();
    for (const r of rows) map.set(`${r.root_message_id}::${r.tenant_id}`, r);
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Compute the effective status of a thread (faithful port of v1 effective_status).
 *
 * Priority:
 *   1. Explicit done/stash AND a newer message arrived after the mark
 *      (thread_end > updated_at) → auto-reactivate to 'running' (read-time only,
 *      no DB write).
 *   2. Explicit status present → return it as-is.
 *   3. Unset + last activity older than STALE_HOURS → 'stale' (read-time).
 *   4. Unset + recent / no activity → 'running'.
 *
 * Note: unlike the (regressed) 1h heuristic this replaces, an unset thread is
 * NEVER reported as 'done'. 'done' is only ever an explicit mark.
 */
export function effectiveStatus(
  rootId: string,
  tenantId: string,
  threadEnd: string | null,
  statusMap: Map<string, StatusRow>,
): EffectiveStatus {
  const key = `${rootId}::${tenantId || 'default'}`;
  const row = statusMap.get(key);
  if (row) {
    // auto-revert: a message after the mark reactivates the thread (read-time)
    if ((row.status === 'done' || row.status === 'stash') && threadEnd && row.updated_at) {
      if (new Date(threadEnd).getTime() > new Date(row.updated_at).getTime()) return 'running';
    }
    return row.status;
  }
  // unset → stale auto-detection
  if (threadEnd) {
    const last = new Date(threadEnd).getTime();
    if (Number.isFinite(last) && Date.now() - last > STALE_HOURS * 60 * 60 * 1000) return 'stale';
  }
  return 'running';
}

/**
 * UPSERT an explicit thread status. Mirrors v1 set_thread_status.
 */
export function setThreadStatus(
  rootId: string,
  tenantId: string,
  status: ThreadStatus,
  updatedBy?: string,
  note?: string,
): void {
  getDataDb()
    .prepare(`
      INSERT INTO dashboard_thread_status (root_message_id, tenant_id, status, updated_at, note, updated_by)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)
      ON CONFLICT(root_message_id, tenant_id) DO UPDATE SET
        status     = excluded.status,
        updated_at = excluded.updated_at,
        note       = excluded.note,
        updated_by = excluded.updated_by
    `)
    .run(rootId, tenantId || 'default', status, note ?? null, updatedBy ?? null);
}
