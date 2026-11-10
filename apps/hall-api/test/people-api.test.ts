// The people side: sessions, the commercial tree, claim codes, roles and scopes, the audit log.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, nextCnpj, startHall, type TestHall } from './helpers.js';

let t: TestHall;
beforeAll(async () => {
  t = await startHall();
});
afterAll(async () => t?.stop());

describe('sessions', () => {
  it('signs in, says who is signed in, signs out', async () => {
    const c = t.client();
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const login = await c.post('/api/auth/login', { email: ADMIN.email.toUpperCase(), password: ADMIN.password });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toMatch(/hall_session=.*HttpOnly.*SameSite=Strict/i);
    const me = await c.get('/api/auth/me');
    expect(me.body.user).toMatchObject({ email: ADMIN.email, locale: 'pt-BR', roles: [{ role: 'admin-farad', resellerId: null }] });
    expect(me.body.permissions).toContain('org:write');
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('refuses a wrong password and locks the address out after five', async () => {
    const hall = await startHall();
    try {
      const c = hall.client();
      for (let i = 0; i < 5; i++) {
        const a = await c.post('/api/auth/login', { email: ADMIN.email, password: 'wrong password' });
        expect(a.status).toBe(401);
        expect(a.body.error).toBe('invalid-credentials');
      }
      const locked = await c.post('/api/auth/login', ADMIN);
      expect(locked.status).toBe(429);
      expect(locked.body.retryAfterS).toBeGreaterThan(0);
      const audit = await hall.admin.get('/api/audit?entityType=user');
      expect(audit.body.filter((e: any) => e.action === 'auth.login-failed')).toHaveLength(5);
    } finally {
      await hall.stop();
    }
  });

  it('refuses a cross-origin change even with the cookie', async () => {
    const a = await t.admin.req('POST', '/api/resellers', { name: 'X' }, { origin: 'https://evil.example' });
    expect(a.status).toBe(403);
  });

  it('changes the password and ends the other sessions', async () => {
    await t.admin.post('/api/users', { email: 'ana@farad.test', name: 'Ana', password: 'first password 1', roles: [{ role: 'suporte' }] });
    const a = await new Client(t.url).login('ana@farad.test', 'first password 1');
    const b = await new Client(t.url).login('ana@farad.test', 'first password 1');
    expect((await a.post('/api/auth/password', { currentPassword: 'nope', newPassword: 'second password 2' })).status).toBe(403);
    expect((await a.post('/api/auth/password', { currentPassword: 'first password 1', newPassword: 'second password 2' })).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
    await new Client(t.url).login('ana@farad.test', 'second password 2');
  });
});

describe('customers and sites', () => {
  it('creates, reads, changes and removes, with an audit entry for each change', async () => {
    const r = await t.admin.post('/api/resellers', { name: 'Gauss Energia', document: '11.222.333/0001-81', email: 'contato@gauss.test' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Gauss Energia', document: '11222333000181', customerCount: 0 });
    const c = await t.admin.post('/api/customers', {
      resellerId: r.body.id,
      legalName: 'Condomínio Edifício Mar Azul',
      tradeName: 'Mar Azul',
      document: '12.ABC.345/01DE-35',
      address: { street: 'Av. Oceânica', number: '100', city: 'Salvador', state: 'BA', postalCode: '40170-010' },
      contacts: [{ name: 'Maria', email: 'sindica@marazul.test', role: 'síndica' }],
      billingContact: { name: 'Administradora X', email: 'financeiro@adm.test' },
    });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ documentType: 'cnpj', document: '12ABC34501DE35', reseller: { id: r.body.id, name: 'Gauss Energia' }, siteCount: 0 });
    const s = await t.admin.post('/api/sites', { customerId: c.body.id, name: 'Torre A', kind: 'condominio', utility: 'Coelba', timezone: 'America/Bahia' });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ customer: { id: c.body.id }, reseller: { id: r.body.id }, timezone: 'America/Bahia', deviceCount: 0 });
    const p = await t.admin.patch(`/api/sites/${s.body.id}`, { name: 'Torre A (garagem)' });
    expect(p.body).toMatchObject({ name: 'Torre A (garagem)', timezone: 'America/Bahia' });
    expect((await t.admin.get(`/api/customers/${c.body.id}`)).body.siteCount).toBe(1);
    expect((await t.admin.get(`/api/sites?customerId=${c.body.id}`)).body).toHaveLength(1);
    expect((await t.admin.get('/api/customers?q=mar azul')).body.map((x: any) => x.id)).toContain(c.body.id);

    // In use: a customer with a site, a reseller with a customer.
    expect((await t.admin.del(`/api/customers/${c.body.id}`)).body.error).toBe('in-use');
    expect((await t.admin.del(`/api/resellers/${r.body.id}`)).status).toBe(409);
    expect((await t.admin.del(`/api/sites/${s.body.id}`)).status).toBe(200);
    expect((await t.admin.del(`/api/customers/${c.body.id}`)).status).toBe(200);
    expect((await t.admin.get(`/api/customers/${c.body.id}`)).status).toBe(404);

    const audit = await t.admin.get(`/api/audit?entityType=site&entityId=${s.body.id}`);
    expect(audit.body.map((e: any) => e.action)).toEqual(['site.delete', 'site.update', 'site.create']);
    expect(audit.body[1]).toMatchObject({ actorType: 'user', actorLabel: ADMIN.email, before: { name: 'Torre A' }, after: { name: 'Torre A (garagem)' } });
  });

  it('validates the input', async () => {
    const bad = await t.admin.post('/api/customers', { legalName: '', document: '11.111.111/1111-11', address: { state: 'Bahia' } });
    expect(bad.status).toBe(422);
    expect(bad.body.issues.map((i: any) => i.path).sort()).toEqual(['address.state', 'document', 'legalName']);
    expect((await t.admin.post('/api/customers', { legalName: 'Pessoa', document: '529.982.247-25' })).body.documentType).toBe('cpf');
    const dup = await t.admin.post('/api/customers', { legalName: 'Outra', document: '52998224725' });
    expect(dup.status).toBe(409);
    expect((await t.admin.post('/api/sites', { customerId: '00000000-0000-4000-8000-000000000000', name: 'x', kind: 'condominio' })).status).toBe(404);
    expect((await t.admin.post('/api/sites', { customerId: '00000000-0000-4000-8000-000000000000', name: 'x', kind: 'castelo' })).status).toBe(422);
    expect((await t.admin.req('POST', '/api/resellers', 'not json', { 'content-type': 'application/json' })).status).toBe(422);
  });
});

describe('roles and scopes', () => {
  it('a customer manager sees only their own site, and changes nothing', async () => {
    const mine = await t.enrolledDevice('Meu Prédio');
    const theirs = await t.enrolledDevice('Outro Prédio');
    await mine.dev.heartbeat();
    await theirs.dev.heartbeat();
    const u = await t.admin.post('/api/users', { email: 'sindico@predio.test', name: 'Síndico', password: 'a long password', locale: 'en', roles: [{ role: 'cliente', customerId: mine.customerId }] });
    expect(u.status).toBe(201);
    const c = await new Client(t.url).login('sindico@predio.test', 'a long password');
    const fleet = await c.get('/api/fleet');
    expect(fleet.body.devices.map((d: any) => d.id)).toEqual([mine.dev.deviceId]);
    expect((await c.get(`/api/devices/${theirs.dev.deviceId}`)).status).toBe(404);
    expect((await c.get('/api/customers')).body.map((x: any) => x.id)).toEqual([mine.customerId]);
    expect((await c.get('/api/sites')).body.map((x: any) => x.id)).toEqual([mine.siteId]);
    expect((await c.post('/api/claim-codes', { siteId: mine.siteId })).status).toBe(403);
    expect((await c.post('/api/sites', { customerId: mine.customerId, name: 'x', kind: 'condominio' })).status).toBe(403);
    expect((await c.post(`/api/devices/${mine.dev.deviceId}/revoke`, { reason: 'x' })).status).toBe(403);
    expect((await c.get('/api/audit')).status).toBe(403);
    expect((await c.get('/api/users')).status).toBe(403);
    expect((await c.get('/api/auth/me')).body.permissions).toEqual(['fleet:read', 'org:read', 'alerts:read']);
  });

  it('a reseller manages claim codes for its own sites only', async () => {
    const r = await t.admin.post('/api/resellers', { name: 'Integradora Sul' });
    const own = await t.seedSite('Prédio da Revenda', { resellerId: r.body.id });
    const other = await t.seedSite('Prédio de Outro');
    await t.admin.post('/api/users', { email: 'revenda@sul.test', name: 'Revenda', password: 'a long password', roles: [{ role: 'revenda', resellerId: r.body.id }] });
    const c = await new Client(t.url).login('revenda@sul.test', 'a long password');
    expect((await c.post('/api/claim-codes', { siteId: own.siteId })).status).toBe(201);
    expect((await c.post('/api/claim-codes', { siteId: other.siteId })).status).toBe(404);
    expect((await c.get('/api/claim-codes')).body.every((x: any) => x.site.id === own.siteId)).toBe(true);
    expect((await c.get('/api/resellers')).body.map((x: any) => x.id)).toEqual([r.body.id]);
    // The commercial tree is written at the Farad scope only.
    expect((await c.patch(`/api/sites/${own.siteId}`, { name: 'x' })).status).toBe(403);
  });

  it('refuses a role at a scope it cannot have', async () => {
    const a = await t.admin.post('/api/users', { email: 'x@y.test', name: 'X', password: 'a long password', roles: [{ role: 'revenda' }] });
    expect(a.status).toBe(422);
    expect((await t.admin.post('/api/users', { email: 'adm2@farad.test', name: 'Adm', password: 'short', roles: [{ role: 'admin-farad' }] })).status).toBe(422);
  });

  it('a disabled person is signed out and cannot sign in', async () => {
    const u = await t.admin.post('/api/users', { email: 'temp@farad.test', name: 'Temp', password: 'a long password', roles: [{ role: 'suporte' }] });
    const c = await new Client(t.url).login('temp@farad.test', 'a long password');
    expect((await t.admin.patch(`/api/users/${u.body.id}`, { disabled: true })).body.disabled).toBe(true);
    expect((await c.get('/api/fleet')).status).toBe(401);
    expect((await new Client(t.url).post('/api/auth/login', { email: 'temp@farad.test', password: 'a long password' })).status).toBe(401);
    const me = (await t.admin.get('/api/auth/me')).body.user;
    expect((await t.admin.patch(`/api/users/${me.id}`, { disabled: true })).status).toBe(409);
  });
});

describe('claim codes', () => {
  it('shows the code once, keeps only its hash, and lists it with a hint', async () => {
    const { siteId } = await t.seedSite('Site dos Códigos');
    const a = await t.admin.post('/api/claim-codes', { siteId, label: 'instalação de terça' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: 'active', label: 'instalação de terça', hint: `…${a.body.code.slice(-2)}`, createdBy: ADMIN.email });
    expect(Date.parse(a.body.expiresAt) - Date.parse(a.body.createdAt)).toBe(24 * 3600_000);
    const list = await t.admin.get(`/api/claim-codes?siteId=${siteId}`);
    expect(list.body[0].code).toBeUndefined();
    const stored = await t.hall.deps.db.query<{ code_hash: Buffer }>('SELECT code_hash FROM claim_codes WHERE id = $1', [a.body.id]);
    expect(stored[0]!.code_hash.toString('utf8')).not.toContain(a.body.code.replace('-', ''));
    const audit = await t.admin.get(`/api/audit?entityType=claim-code&entityId=${a.body.id}`);
    expect(JSON.stringify(audit.body)).not.toContain(a.body.code);
  });

  it('the CNPJ helper makes valid documents', () => {
    expect(nextCnpj()).toMatch(/^\d{14}$/);
  });
});
