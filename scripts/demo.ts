// pnpm demo: a local Hall with a fleet of simulated Orquestras, to look at.
//
// Starts a private Postgres (or uses DATABASE_URL), hall-api serving the built web UI, an admin,
// customers and sites, and five simulated devices that enrol with claim codes and keep sending
// heartbeats and state: one in fallback, one with a critical event, one gone quiet. The last 24 h
// of presence are filled in so the device pages have a history. Ctrl-C stops everything.
import { join } from 'node:path';
import { SimDevice } from '@hall/device-sim';
import { startPostgres } from '@hall/test-support';
import { bootstrapAdmin, buildHall, testConfig } from '@hall/api';

const PORT = Number(process.env['HALL_DEMO_PORT'] ?? 8080);
const EMAIL = 'admin@farad.local';
const PASSWORD = 'farad-hall-demo';
const root = join(import.meta.dirname, '..');

const pg = process.env['DATABASE_URL'] ? undefined : await startPostgres();
const config = testConfig(process.env['DATABASE_URL'] ?? pg!.url, {
  port: PORT,
  webDir: join(root, 'apps/hall-web/dist'),
  logLevel: 'warn',
  intervals: { heartbeatS: 15, stateS: 60 },
  publicUrl: `http://localhost:${PORT}`,
  // The simulated devices say, as Caddy would, which public address they come from.
  trustProxy: '127.0.0.1',
});
const hall = await buildHall({ config, logger: true });
await hall.app.listen({ host: '127.0.0.1', port: PORT });
const stopJobs = hall.startJobs();
await bootstrapAdmin(hall.deps, EMAIL, PASSWORD);
const url = `http://127.0.0.1:${PORT}`;
const db = hall.deps.db;

// ---------------------------------------------------------------- the commercial tree --
/** A made-up CNPJ with valid check digits, from an 8-digit base (branch 0001). */
function cnpj(base: string): string {
  const b = `${base}0001`;
  const d = (x: string, w: number[]) => {
    const r = [...x].reduce((n, c, i) => n + Number(c) * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = d(b, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${b}${d1}${d(b + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])}`;
}

async function call<T = { id: string }>(method: string, path: string, body?: unknown, cookie?: string): Promise<{ body: T; cookie?: string }> {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return { body: json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const { cookie } = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
const api = <T = { id: string }>(method: string, path: string, body?: unknown) => call<T>(method, path, body, cookie).then((r) => r.body);

const have = (await db.query('SELECT 1 FROM customers LIMIT 1')).length > 0;
if (!have) {
  await api('PUT', '/api/settings/alerts', { offlineAfterMin: 5, emailEnabled: true, recipients: ['noc@farad.local'], notifyResolved: true });
  const gauss = await api('POST', '/api/resellers', { name: 'Gauss Energia', document: '11.222.333/0001-81', email: 'contato@gauss.local' });
  const customers: { legalName: string; document: string; city: string; resellerId: string | null; sites: [string, string][] }[] = [
    { legalName: 'Condomínio Edifício Aurora', document: '12.ABC.345/01DE-35', city: 'Salvador', resellerId: gauss.id, sites: [['Edifício Aurora', 'condominio']] },
    { legalName: 'Condomínio Residencial Mar Azul', document: cnpj('48151623'), city: 'Salvador', resellerId: gauss.id, sites: [['Mar Azul · Torre A', 'condominio'], ['Mar Azul · Torre B', 'condominio']] },
    { legalName: 'Rota 324 Recarga Ltda', document: cnpj('32457788'), city: 'Feira de Santana', resellerId: null, sites: [['Eletroposto Rota 324', 'eletroposto']] },
    { legalName: 'Logística Recôncavo S.A.', document: cnpj('27182818'), city: 'Camaçari', resellerId: null, sites: [['CD Camaçari', 'empresa']] },
  ];
  const sims: { dev: SimDevice; site: string }[] = [];
  let n = 0;
  for (const c of customers) {
    const cust = await api('POST', '/api/customers', {
      legalName: c.legalName,
      document: c.document,
      resellerId: c.resellerId,
      address: { city: c.city, state: 'BA' },
      contacts: [{ name: 'Gestor', email: `gestor${++n}@cliente.local` }],
    });
    for (const [name, kind] of c.sites) {
      const site = await api('POST', '/api/sites', { customerId: cust.id, name, kind, utility: 'Coelba', address: { city: c.city, state: 'BA' } });
      const code = await api<{ code: string }>('POST', '/api/claim-codes', { siteId: site.id, label: 'demo' });
      const dev = new SimDevice(url, { profile: { hostname: `orquestra-${name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, version: sims.length === 3 ? 'v1.3.2' : 'v1.4.0', forwardedFor: `177.${20 + sims.length}.${100 + sims.length}.${10 + sims.length * 7}` } });
      const a = await dev.enrol(code.code);
      if (a.status !== 201) throw new Error(`enrol ${name}: ${JSON.stringify(a.body)}`);
      sims.push({ dev, site: name! });
    }
  }
  // One spare claim code, active, for the claim-codes screen.
  const firstSite = (await db.one<{ id: string }>("SELECT id FROM sites WHERE name = 'Eletroposto Rota 324'"))!;
  await api('POST', '/api/claim-codes', { siteId: firstSite.id, label: 'troca do equipamento' });

  // 24 h of history: a heartbeat every 15 s (an outage on Torre B 3 h ago), a state every 5 min.
  for (const [i, { dev }] of sims.entries()) {
    await db.query(
      `INSERT INTO heartbeats (device_id, received_at, sent_at, version, uptime_s, public_ip, lan_ip, protocol_version)
       SELECT $1, t, t, $2, 3600 * 30 + extract(epoch FROM t - (now() - interval '24 hours'))::bigint, $3::inet, $4::inet, 1
         FROM generate_series(now() - interval '24 hours', now() - interval '1 minute', interval '15 seconds') AS t
        WHERE NOT ($5 AND t BETWEEN now() - interval '3 hours' AND now() - interval '2 hours 20 minutes')
          AND random() > 0.01`,
      [dev.deviceId, dev.profile.version, `177.${20 + i}.${100 + i}.${10 + i * 7}`, dev.profile.lanIp, i === 2],
    );
    await db.query(
      `INSERT INTO device_states (device_id, received_at, sent_at, protocol_version, control_mode, health_ok, cpu_pct, mem_pct, disk_pct, temperature_c, payload)
       SELECT $1, t, t, 1, 'normal', true, 8 + random() * 20, 38 + random() * 6, 31.4, 48 + random() * 8, '{}'::jsonb
         FROM generate_series(now() - interval '24 hours', now() - interval '5 minutes', interval '5 minutes') AS t`,
      [dev.deviceId],
    );
  }
  // Events of the last day.
  await sims[1]!.dev.events([
    SimDevice.event({ severity: 'warning', kind: 'charger-offline', chargerId: 'cp-03', message: 'cp-03 lost its OCPP connection', timestamp: new Date(Date.now() - 5 * 3600_000).toISOString() }),
    SimDevice.event({ severity: 'warning', kind: 'session-paused', chargerId: 'cp-01', message: 'cp-01/1 paused: no capacity', timestamp: new Date(Date.now() - 2 * 3600_000).toISOString() }),
  ]);
  await sims[3]!.dev.events([SimDevice.event({ kind: 'invariant-violated', message: 'the floors no longer fit under the main limit on L2' })]);
  for (const s of sims) s.dev.save(join(root, '.demo', `${s.site.replace(/[^\w]+/g, '-')}.json`));
}

// ---------------------------------------------------------------------- the devices --
const { readdirSync } = await import('node:fs');
const files = readdirSync(join(root, '.demo')).filter((f) => f.endsWith('.json'));
const ctrl = new AbortController();
const running: Promise<void>[] = [];
for (const f of files) {
  const dev = SimDevice.load(url, join(root, '.demo', f));
  if (f.startsWith('Mar-Azul-Torre-A')) dev.profile.controlMode = 'fallback-analyzer';
  // CD Camaçari went quiet 20 minutes ago (its link is down): it sends nothing.
  if (f.startsWith('CD-Cama')) {
    await db.query("UPDATE devices SET last_seen_at = now() - interval '20 minutes', last_heartbeat_at = now() - interval '20 minutes' WHERE id = $1", [dev.deviceId]);
    await db.query("DELETE FROM heartbeats WHERE device_id = $1 AND received_at > now() - interval '20 minutes'", [dev.deviceId]);
    await dev.state();
    await db.query("UPDATE devices SET last_seen_at = now() - interval '20 minutes' WHERE id = $1", [dev.deviceId]);
    continue;
  }
  running.push(
    dev.run({
      heartbeatS: 15,
      stateS: 60,
      signal: ctrl.signal,
      onAnswer: (what, a) => a.status >= 300 && console.error(`${f} ${what}: ${a.status} ${JSON.stringify(a.body)}`),
      onError: (e) => console.error(`${f}: ${e.message}`),
    }),
  );
}
await hall.deps.alerts.checkOffline();

console.log(`
  Farad Hall demo: ${url}
  sign in: ${EMAIL} / ${PASSWORD}
  ${running.length} simulated Orquestras sending; Ctrl-C to stop.
`);

const stop = async () => {
  ctrl.abort();
  await Promise.all(running);
  stopJobs();
  await hall.close();
  await pg?.stop();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
