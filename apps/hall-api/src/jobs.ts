// Background work: the offline check (every 30 s), and every hour the pruning of old nonces,
// sessions and telemetry (HALL_RETENTION_*_DAYS). Each run takes an advisory lock, so with several
// API processes one does it.
import type { Deps } from './context.js';

export interface JobLog {
  error: (o: object, m: string) => void;
  info: (o: object, m: string) => void;
}

/** Deletes in batches, so a big backlog never holds a long lock. */
async function pruneTable(deps: Deps, table: string, column: string, before: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await deps.db.query<{ n: number }>(
      `WITH gone AS (DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${column} < $1 LIMIT 5000) RETURNING 1) SELECT count(*) AS n FROM gone`,
      [before],
    );
    const n = rows[0]?.n ?? 0;
    total += n;
    if (n < 5000) return total;
  }
}

export async function prune(deps: Deps): Promise<Record<string, number>> {
  const now = deps.now().getTime();
  const days = (d: number) => new Date(now - d * 86_400_000);
  const r = deps.config.retentionDays;
  return {
    nonces: await pruneTable(deps, 'device_nonces', 'expires_at', new Date(now)),
    sessions: await pruneTable(deps, 'sessions', 'expires_at', new Date(now)),
    heartbeats: await pruneTable(deps, 'heartbeats', 'received_at', days(r.heartbeats)),
    states: await pruneTable(deps, 'device_states', 'received_at', days(r.states)),
    events: await pruneTable(deps, 'device_events', 'received_at', days(r.events)),
    audit: await pruneTable(deps, 'audit_log', 'at', days(r.audit)),
  };
}

export function startJobs(deps: Deps, log: JobLog): () => void {
  let stopped = false;
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    const t = setInterval(() => {
      if (running || stopped) return;
      running = true;
      fn()
        .catch((err: Error) => log.error({ job: name, err: err.message }, 'job failed'))
        .finally(() => (running = false));
    }, ms);
    t.unref();
    return t;
  };
  const timers = [
    every(30_000, 'offline-check', () => deps.alerts.checkOffline()),
    every(3600_000, 'prune', async () => {
      // A session-level lock lives on one connection: hold that connection for the whole run.
      const client = await deps.db.pool.connect();
      try {
        const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(7470003) AS ok');
        if (!lock.rows[0]?.ok) return;
        try {
          log.info(await prune(deps), 'pruned');
        } finally {
          await client.query('SELECT pg_advisory_unlock(7470003)');
        }
      } finally {
        client.release();
      }
    }),
  ];
  return () => {
    stopped = true;
    timers.forEach(clearInterval);
  };
}
