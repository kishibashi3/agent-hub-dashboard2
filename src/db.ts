import Database from 'better-sqlite3';
import { DB_PATH, TENANT } from './constants.js';

export function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: false });
}

export function tenantCond(alias = ''): { cond: string; params: unknown[] } {
  if (TENANT === null) return { cond: '', params: [] };
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return { cond: `AND ${col} = ?`, params: [TENANT] };
}
