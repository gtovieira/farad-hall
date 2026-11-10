// Real infrastructure for tests and the local demo. Every run gets its OWN Postgres on a free port,
// so parallel runs never collide and no test depends on a developer's local database. Local
// binaries are preferred (about 1 s to start); without them a Docker container is used. Override
// discovery with PG_BIN (a directory holding initdb, pg_ctl and postgres).
import { execFileSync, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A TCP port that was free a moment ago. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Polls `check` until it returns something truthy; throws on timeout. */
export async function waitFor<T>(
  what: string,
  check: () => T | Promise<T>,
  { timeoutMs = 10_000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<NonNullable<T>> {
  const t0 = Date.now();
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await check();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastErr ? ` (last error: ${String(lastErr)})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function which(bin: string): string | undefined {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  const out = r.stdout.trim();
  return r.status === 0 && out ? out : undefined;
}

const hasServer = (dir: string) => ['initdb', 'pg_ctl', 'postgres'].every((b) => existsSync(join(dir, b)));

/** The directory of the newest local Postgres server binaries, if any. */
export function findPgBin(): string | undefined {
  if (process.env['PG_BIN']) return process.env['PG_BIN'];
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((v) => hasServer(join(base, v, 'bin')))
      .sort((a, b) => Number(b) - Number(a));
    if (versions[0]) return join(base, versions[0], 'bin');
  }
  const initdb = which('initdb');
  return initdb ? join(initdb, '..') : undefined;
}

function postgresUser(): { uid: number; gid: number } | undefined {
  const u = spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' });
  const g = spawnSync('id', ['-g', 'postgres'], { encoding: 'utf8' });
  if (u.status !== 0 || g.status !== 0) return undefined;
  return { uid: Number(u.stdout.trim()), gid: Number(g.stdout.trim()) };
}

export interface TestPostgres {
  /** postgres://postgres@127.0.0.1:<port>/hall (trust auth: tests and the demo only). */
  url: string;
  port: number;
  stop(): Promise<void>;
}

export async function startPostgres(opts: { database?: string } = {}): Promise<TestPostgres> {
  const database = opts.database ?? 'hall';
  const port = await freePort();
  const bin = findPgBin();
  if (bin) {
    const dataDir = mkdtempSync(join(tmpdir(), 'hall-pg-'));
    // initdb refuses to run as root: run the server as the postgres user.
    const asRoot = process.getuid?.() === 0;
    const pgUser = asRoot ? postgresUser() : undefined;
    if (asRoot && !pgUser) throw new Error('startPostgres: running as root but there is no postgres system user');
    if (pgUser) chownSync(dataDir, pgUser.uid, pgUser.gid);
    const run = (cmd: string, args: string[]) => {
      const [file, argv] = pgUser ? ['runuser', ['-u', 'postgres', '--', join(bin, cmd), ...args]] : [join(bin, cmd), args];
      const r = spawnSync(file, argv, { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
      return r.stdout;
    };
    run('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync', '--locale=C']);
    const o = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${dataDir} -c fsync=off -c full_page_writes=off -c synchronous_commit=off`;
    run('pg_ctl', ['-D', dataDir, '-o', o, '-l', join(dataDir, 'server.log'), '-w', '-t', '30', 'start']);
    await createDatabase(port, database);
    return {
      url: `postgres://postgres@127.0.0.1:${port}/${database}`,
      port,
      stop: async () => {
        try {
          run('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
        } catch {
          /* already down */
        }
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  }

  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('startPostgres: no Postgres binaries (install postgresql or set PG_BIN) and no Docker daemon');
  }
  const id = execFileSync(
    'docker',
    ['run', '-d', '--rm', '-p', `127.0.0.1:${port}:5432`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${database}`, 'postgres:17-bookworm', '-c', 'fsync=off'],
    { encoding: 'utf8' },
  ).trim();
  await waitFor('the postgres container', () => spawnSync('docker', ['exec', id, 'pg_isready', '-U', 'postgres', '-d', database]).status === 0, {
    timeoutMs: 60_000,
    intervalMs: 500,
  });
  return {
    url: `postgres://postgres@127.0.0.1:${port}/${database}`,
    port,
    stop: async () => {
      spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
    },
  };
}

/** CREATE DATABASE over the wire (no psql needed: some installs have only the server binaries). */
async function createDatabase(port: number, database: string): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${database.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}
