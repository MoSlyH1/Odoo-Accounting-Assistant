import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

let pool = null;
let migrated = null;

export const dbEnabled = () => Boolean(config.db.url);

export function getPool() {
  if (!dbEnabled()) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.db.url,
      ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
      max: 5, // small pool: serverless instances each hold their own
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

// Runs every .sql file in ./migrations once per process (idempotent SQL).
export async function migrate() {
  if (!dbEnabled()) return;
  if (!migrated) {
    migrated = (async () => {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) await getPool().query(fs.readFileSync(path.join(dir, f), 'utf8'));
    })().catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

export async function query(sql, params) {
  if (!dbEnabled()) return { rows: [] };
  await migrate();
  return getPool().query(sql, params);
}
