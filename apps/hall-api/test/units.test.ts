// The pieces without HTTP: documents, passwords, the lockout, roles, migrations, configuration.
import { startPostgres } from '@hall/test-support';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Lockout } from '../src/auth/lockout.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { scopeOf } from '../src/auth/rbac.js';
import { loadConfig } from '../src/config.js';
import { Db, migrate } from '../src/db.js';
import { documentTypeOf, isValidCnpj, isValidCpf, normalizeDocument } from '../src/documents.js';

describe('documents', () => {
  it('checks CPF and CNPJ, alphanumeric CNPJ included', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11222333000182')).toBe(false);
    // The Receita Federal's example of the alphanumeric CNPJ (from July 2026).
    expect(isValidCnpj(normalizeDocument('12.ABC.345/01DE-35'))).toBe(true);
    expect(isValidCnpj('12ABC34501DE36')).toBe(false);
    expect(documentTypeOf('52998224725')).toBe('cpf');
    expect(documentTypeOf('11222333000181')).toBe('cnpj');
    expect(documentTypeOf('123')).toBeUndefined();
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('correct horsE', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await hashPassword('correct horse')).not.toBe(h);
  });
});

describe('lockout', () => {
  it('locks after max failures and frees after the window', () => {
    const l = new Lockout(3, 1000);
    expect(l.fail('a', 0)).toBe(2);
    l.fail('a', 100);
    expect(l.retryAfterS('a', 200)).toBe(0);
    l.fail('a', 200);
    expect(l.retryAfterS('a', 300)).toBe(1);
    expect(l.retryAfterS('a', 1001)).toBe(0);
    expect(l.retryAfterS('b', 300)).toBe(0);
  });
});

describe('roles', () => {
  const user = (roles: any[]) => ({ id: 'u', email: 'e', name: 'n', locale: 'pt-BR' as const, roles });
  it('unions the scopes of the roles that grant a permission', () => {
    const u = user([
      { role: 'cliente', resellerId: null, customerId: 'c1', siteId: null },
      { role: 'suporte', resellerId: 'r1', customerId: null, siteId: null },
    ]);
    expect(scopeOf(u, 'fleet:read')).toEqual({ all: false, resellerIds: ['r1'], customerIds: ['c1'], siteIds: [] });
    expect(scopeOf(u, 'devices:manage')).toEqual({ all: false, resellerIds: ['r1'], customerIds: [], siteIds: [] });
    expect(scopeOf(u, 'users:manage')).toBeNull();
    expect(scopeOf(user([{ role: 'admin-farad', resellerId: null, customerId: null, siteId: null }]), 'users:manage')).toEqual({ all: true });
  });
});

describe('configuration', () => {
  it('reads the environment and refuses half an admin', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', HALL_TRUST_PROXY: '1', HALL_ALERT_RECIPIENTS: 'a@x.test, b@x.test', SMTP_HOST: 'smtp.x.test' });
    expect(c).toMatchObject({ trustProxy: 1, cookieSecure: true, alerts: { recipients: ['a@x.test', 'b@x.test'] }, mail: { transport: 'smtp', host: 'smtp.x.test', port: 587 } });
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).mail.transport).toBe('log');
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', HALL_ADMIN_EMAIL: 'a@x.test' })).toThrow(/both/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});

describe('migrations', () => {
  it('apply once, under a lock, and refuse an edited one', async () => {
    const pg = await startPostgres();
    const db = new Db(pg.url);
    try {
      const [a, b] = await Promise.all([migrate(db), migrate(db)]);
      expect([...a, ...b]).toEqual(['0001_init.sql']);
      expect(await migrate(db)).toEqual([]);
      const dir = mkdtempSync(join(tmpdir(), 'hall-mig-'));
      writeFileSync(join(dir, '0001_init.sql'), '-- changed\n');
      await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/);
      writeFileSync(join(dir, '0001_init.sql'), (await import('node:fs')).readFileSync(join(import.meta.dirname, '..', 'migrations', '0001_init.sql'), 'utf8'));
      writeFileSync(join(dir, '0002_bad.sql'), 'SELECT nonsense FROM nowhere;');
      await expect(migrate(db, dir)).rejects.toThrow(/0002_bad.sql failed/);
      expect((await db.query('SELECT name FROM schema_migrations')).map((r) => r['name'])).toEqual(['0001_init.sql']);
    } finally {
      await db.close();
      await pg.stop();
    }
  });
});
