// Postgres: one pool, queries with parameters, transactions, and the migration runner.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

// bigint (count(*), identities) as a JS number: every one of ours fits in 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric as a number (averages).
pg.types.setTypeParser(1700, (v) => Number(v));

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export class Db {
  readonly pool: pg.Pool;
  constructor(url: string, max = 10) {
    this.pool = new pg.Pool({ connectionString: url, max, application_name: 'hall-api' });
    // A dropped idle connection must not crash the process; the pool replaces it.
    this.pool.on('error', () => {});
  }

  async query<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = [], on: Queryable = this.pool): Promise<T[]> {
    const r = await on.query<T>(sql, params);
    return r.rows;
  }

  async one<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = [], on: Queryable = this.pool): Promise<T | undefined> {
    return (await this.query<T>(sql, params, on))[0];
  }

  /** Runs `fn` in a transaction: committed if it returns, rolled back if it throws. */
  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/**
 * Applies the migrations not applied yet (migrations/NNNN_name.sql, in name order), each in its own
 * transaction, under an advisory lock (several API processes may start at once). A migration
 * already applied must not change: its checksum is checked.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const client = await db.pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(7470001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const had = done.get(file);
      if (had) {
        if (had !== checksum) throw new Error(`migration ${file} changed after it was applied: write a new migration instead`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7470001)').catch(() => {});
    client.release();
  }
  return applied;
}

/** ISO string of a timestamp column (null stays null). */
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
