// The fleet view and the device page's data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prune } from '../src/index.js';
import { startHall, type TestHall } from './helpers.js';

let t: TestHall;
beforeAll(async () => {
  t = await startHall();
});
afterAll(async () => t?.stop());

describe('fleet', () => {
  it('lists every device with presence, version, IPs and open alerts', async () => {
    const a = await t.enrolledDevice('Alfa');
    const b = await t.enrolledDevice('Bravo');
    a.dev.profile.version = 'v1.5.0';
    await a.dev.heartbeat();
    await b.dev.heartbeat();
    // Bravo went quiet 10 minutes ago.
    await t.hall.deps.db.query("UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE id = $1", [b.dev.deviceId]);
    await t.hall.deps.alerts.checkOffline();
    const f = await t.admin.get('/api/fleet');
    expect(f.status).toBe(200);
    const rows = Object.fromEntries(f.body.devices.map((d: any) => [d.site.name, d]));
    expect(rows['Alfa']).toMatchObject({ presence: 'online', version: 'v1.5.0', publicIp: '127.0.0.1', lanIp: a.dev.profile.lanIp, openAlerts: 0, customer: { name: 'Condomínio Alfa' } });
    expect(rows['Bravo']).toMatchObject({ presence: 'offline', openAlerts: 1, criticalAlerts: 1 });
    expect(f.body.summary).toMatchObject({ total: 2, online: 1, offline: 1, withAlerts: 1, openAlerts: 1 });
    expect(f.body.onlineWindowS).toBe(180);
    expect((await t.admin.get(`/api/fleet?siteId=${a.siteId}`)).body.devices).toHaveLength(1);
  });

  it('the device page: presence history, metrics, heartbeats, events', async () => {
    const { dev } = await t.enrolledDevice('Charlie');
    for (let i = 0; i < 3; i++) await dev.heartbeat();
    await dev.state();
    await dev.state();
    const p = await t.admin.get(`/api/devices/${dev.deviceId}/presence?hours=6`);
    expect(p.body.bucketS).toBe(300);
    expect(p.body.buckets).toHaveLength(72);
    expect(p.body.expectedPerBucket).toBe(5);
    expect(p.body.buckets.reduce((n: number, b: any) => n + b.heartbeats, 0)).toBe(3);
    expect((await t.admin.get(`/api/devices/${dev.deviceId}/presence?hours=168`)).body.bucketS).toBe(3600);
    const m = await t.admin.get(`/api/devices/${dev.deviceId}/metrics`);
    expect(m.body.points).toHaveLength(2);
    expect(m.body.points[0]).toMatchObject({ controlMode: 'normal', healthOk: true });
    expect(m.body.points[0].temperatureC).toBeGreaterThan(40);
    const h = await t.admin.get(`/api/devices/${dev.deviceId}/heartbeats?limit=2`);
    expect(h.body).toHaveLength(2);
    expect(h.body[0]).toMatchObject({ version: 'v1.4.0', publicIp: '127.0.0.1' });
    const d = await t.admin.get(`/api/devices/${dev.deviceId}`);
    expect(d.body).toMatchObject({ hostname: dev.profile.hostname, model: dev.profile.model, serial: dev.profile.serial, apiVersion: '1.1.0', enrolledIp: '127.0.0.1' });
    expect(d.body.lastState.resources.diskPct).toBe(31.4);
    expect((await t.admin.get('/api/devices/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await t.admin.get('/api/devices/not-a-uuid')).status).toBe(422);
  });

  it('renames a device and moves it to another site, keeping its history', async () => {
    const { dev, siteId } = await t.enrolledDevice('Delta');
    await dev.heartbeat();
    const other = await t.seedSite('Delta Novo');
    const p = await t.admin.patch(`/api/devices/${dev.deviceId}`, { name: 'Delta · garagem', siteId: other.siteId });
    expect(p.body).toMatchObject({ name: 'Delta · garagem', site: { id: other.siteId, name: 'Delta Novo' } });
    expect((await t.admin.get(`/api/devices/${dev.deviceId}/heartbeats`)).body).toHaveLength(1);
    expect((await dev.heartbeat()).status).toBe(200);
    const audit = await t.admin.get(`/api/audit?entityType=device&entityId=${dev.deviceId}`);
    expect(audit.body[0]).toMatchObject({ action: 'device.transfer', before: { siteId }, after: { siteId: other.siteId } });
  });

  it('prunes telemetry older than its retention', async () => {
    const { dev } = await t.enrolledDevice('Echo');
    await dev.heartbeat();
    await dev.heartbeat();
    await t.hall.deps.db.query("UPDATE heartbeats SET received_at = now() - interval '30 days' WHERE device_id = $1 AND id = (SELECT min(id) FROM heartbeats WHERE device_id = $1)", [dev.deviceId]);
    const n = await prune(t.hall.deps);
    expect(n.heartbeats).toBeGreaterThanOrEqual(1);
    expect((await t.admin.get(`/api/devices/${dev.deviceId}/heartbeats`)).body).toHaveLength(1);
  });
});

describe('health', () => {
  it('answers without a session', async () => {
    const h = await t.client().get('/api/health');
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ ok: true, protocol: { current: 1, supported: [1] }, db: { ok: true } });
  });
});
