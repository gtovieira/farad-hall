// A real Hall for each test file: a private Postgres, the app listening on a free port, an admin,
// and an HTTP client that keeps the session cookie.
import { SimDevice } from '@hall/device-sim';
import { startPostgres, type TestPostgres } from '@hall/test-support';
import { bootstrapAdmin, buildHall, MemoryMailer, testConfig, type Config, type Hall } from '../src/index.js';

export const ADMIN = { email: 'admin@farad.test', password: 'correct horse battery staple' };

export interface Answer<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  cookie: string | undefined;
  constructor(readonly url: string) {}

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer<T>> {
    const res = await fetch(this.url + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set?.startsWith('hall_session=')) {
      const pair = set.split(';')[0]!;
      this.cookie = pair === 'hall_session=' ? undefined : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  get = <T = any>(path: string) => this.req<T>('GET', path);
  post = <T = any>(path: string, body?: unknown) => this.req<T>('POST', path, body ?? {});
  patch = <T = any>(path: string, body: unknown) => this.req<T>('PATCH', path, body);
  put = <T = any>(path: string, body: unknown) => this.req<T>('PUT', path, body);
  del = <T = any>(path: string) => this.req<T>('DELETE', path);

  async login(email = ADMIN.email, password = ADMIN.password): Promise<this> {
    const a = await this.post('/api/auth/login', { email, password });
    if (a.status !== 200) throw new Error(`login failed: ${a.status} ${JSON.stringify(a.body)}`);
    return this;
  }
}

export interface TestHall {
  hall: Hall;
  pg: TestPostgres;
  url: string;
  mailer: MemoryMailer;
  admin: Client;
  client(): Client;
  sim(profile?: ConstructorParameters<typeof SimDevice>[1]): SimDevice;
  /** A customer and a site through the API. */
  seedSite(name?: string, opts?: { resellerId?: string; document?: string }): Promise<{ customerId: string; siteId: string }>;
  claimCode(siteId: string): Promise<string>;
  /** A device enrolled at a new site. */
  enrolledDevice(siteName?: string): Promise<{ dev: SimDevice; siteId: string; customerId: string }>;
  stop(): Promise<void>;
}

/** Valid CNPJs for test customers (check digits computed). */
let docSeq = 0;
export function nextCnpj(): string {
  const base = `${String(11222333 + ++docSeq).padStart(8, '0')}0001`;
  const d = (s: string, w: number[]) => {
    const r = [...s].reduce((n, c, i) => n + Number(c) * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = d(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = d(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${d1}${d2}`;
}

export async function startHall(over: Partial<Config> = {}): Promise<TestHall> {
  const pg = await startPostgres();
  const mailer = new MemoryMailer();
  const hall = await buildHall({ config: testConfig(pg.url, over), mailer, validateResponses: true });
  await hall.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = hall.app.server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  await bootstrapAdmin(hall.deps, ADMIN.email, ADMIN.password);
  const admin = await new Client(url).login();

  const t: TestHall = {
    hall,
    pg,
    url,
    mailer,
    admin,
    client: () => new Client(url),
    sim: (opts) => new SimDevice(url, opts),
    seedSite: async (name = 'Edifício Aurora', opts = {}) => {
      const c = await admin.post('/api/customers', { legalName: `Condomínio ${name}`, document: opts.document ?? nextCnpj(), resellerId: opts.resellerId ?? null });
      if (c.status !== 201) throw new Error(`customer: ${c.status} ${JSON.stringify(c.body)}`);
      const s = await admin.post('/api/sites', { customerId: c.body.id, name, kind: 'condominio', address: { city: 'Salvador', state: 'BA' } });
      if (s.status !== 201) throw new Error(`site: ${s.status} ${JSON.stringify(s.body)}`);
      return { customerId: c.body.id, siteId: s.body.id };
    },
    claimCode: async (siteId) => {
      const a = await admin.post('/api/claim-codes', { siteId });
      if (a.status !== 201) throw new Error(`claim code: ${a.status} ${JSON.stringify(a.body)}`);
      return a.body.code as string;
    },
    enrolledDevice: async (siteName = `Site ${Math.random().toString(36).slice(2, 7)}`) => {
      const { siteId, customerId } = await t.seedSite(siteName);
      const dev = t.sim();
      const a = await dev.enrol(await t.claimCode(siteId));
      if (a.status !== 201) throw new Error(`enrol: ${a.status} ${JSON.stringify(a.body)}`);
      return { dev, siteId, customerId };
    },
    stop: async () => {
      await hall.close();
      await pg.stop();
    },
  };
  return t;
}
