// The device side end to end: a simulated hall-agent enrols with a claim code and sends signed
// messages over real HTTP to a real Hall on a real Postgres.
import { DEVICE_PATHS, generateDeviceKeys, newNonce } from '@hall/protocol';
import { SimDevice } from '@hall/device-sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHall, type TestHall } from './helpers.js';

let t: TestHall;
beforeAll(async () => {
  t = await startHall();
});
afterAll(async () => t?.stop());

describe('enrolment', () => {
  it('enrols a device with a claim code and its public key', async () => {
    const { siteId, customerId } = await t.seedSite('Edifício Aurora');
    const code = await t.claimCode(siteId);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const dev = t.sim({ profile: { hostname: 'aurora-pi' } });
    const a = await dev.enrol(code.toLowerCase().replace('-', ' '));
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ protocolVersion: 1, site: { id: siteId, name: 'Edifício Aurora' }, customer: { id: customerId }, intervals: { heartbeatS: 60, stateS: 300 } });
    const d = await t.admin.get(`/api/devices/${a.body.deviceId}`);
    expect(d.body).toMatchObject({ name: 'aurora-pi', status: 'active', publicKey: dev.keys.publicKey, version: 'v1.4.0', site: { id: siteId } });
    const cc = await t.admin.get(`/api/claim-codes?siteId=${siteId}`);
    expect(cc.body[0]).toMatchObject({ status: 'used', device: { id: a.body.deviceId } });
    const audit = await t.admin.get(`/api/audit?entityType=device&entityId=${a.body.deviceId}`);
    expect(audit.body[0]).toMatchObject({ action: 'device.enrol', actorType: 'device' });
  });

  it('refuses a claim code used already', async () => {
    const { siteId } = await t.seedSite();
    const code = await t.claimCode(siteId);
    expect((await t.sim().enrol(code)).status).toBe(201);
    const again = await t.sim().enrol(code);
    expect(again.status).toBe(410);
    expect(again.body.error).toBe('claim-code-used');
  });

  it('refuses an expired claim code', async () => {
    const { siteId } = await t.seedSite();
    const code = await t.claimCode(siteId);
    await t.hall.deps.db.query("UPDATE claim_codes SET expires_at = now() - interval '1 minute' WHERE site_id = $1", [siteId]);
    const a = await t.sim().enrol(code);
    expect(a.status).toBe(410);
    expect(a.body.error).toBe('claim-code-expired');
    expect((await t.admin.get(`/api/claim-codes?siteId=${siteId}`)).body[0].status).toBe('expired');
  });

  it('refuses unknown, malformed and revoked codes', async () => {
    expect((await t.sim().enrol('ZZZZ-ZZZZ')).body.error).toBe('claim-code-invalid');
    expect((await t.sim().enrol('0000-0000')).status).toBe(404);
    const { siteId } = await t.seedSite();
    const code = await t.claimCode(siteId);
    const list = await t.admin.get(`/api/claim-codes?siteId=${siteId}`);
    expect((await t.admin.del(`/api/claim-codes/${list.body[0].id}`)).body.status).toBe('revoked');
    expect((await t.sim().enrol(code)).body.error).toBe('claim-code-invalid');
  });

  it('refuses a public key enrolled already', async () => {
    const { siteId } = await t.seedSite();
    const keys = generateDeviceKeys();
    expect((await new SimDevice(t.url, { keys }).enrol(await t.claimCode(siteId))).status).toBe(201);
    const second = await new SimDevice(t.url, { keys }).enrol(await t.claimCode(siteId));
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already-enrolled');
  });

  it('needs the enrolment signed with the key it presents', async () => {
    const { siteId } = await t.seedSite();
    const code = await t.claimCode(siteId);
    const dev = t.sim();
    const other = generateDeviceKeys();
    const body = { protocolVersion: 1, claimCode: code, publicKey: other.publicKey, device: { orquestraVersion: 'v1.4.0' } };
    const a = await dev.send(DEVICE_PATHS.enrol, body);
    expect(a.status).toBe(401);
    expect((a.body as any).error).toBe('bad-signature');
    // The code was not spent.
    expect((await t.sim().enrol(code)).status).toBe(201);
  });

  it('limits failed claim codes per address', async () => {
    const hall = await import('./helpers.js').then((h) => h.startHall());
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) statuses.push((await hall.sim().enrol('ZZZZ-ZZZZ')).status);
      expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
      expect(statuses[20]).toBe(429);
    } finally {
      await hall.stop();
    }
  });
});

describe('signed requests', () => {
  let dev: SimDevice;
  beforeAll(async () => {
    ({ dev } = await t.enrolledDevice());
  });

  it('accepts a good heartbeat and records the public IP Hall saw', async () => {
    const a = await dev.heartbeat();
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ protocolVersion: 1, accepted: true, publicIp: '127.0.0.1', intervals: { heartbeatS: 60 } });
    const d = await t.admin.get(`/api/devices/${dev.deviceId}`);
    expect(d.body).toMatchObject({ presence: 'online', publicIp: '127.0.0.1', lanIp: dev.profile.lanIp, version: 'v1.4.0', protocolVersion: 1 });
    expect(d.body.uptimeS).toBeGreaterThan(3000);
  });

  it('refuses a bad signature', async () => {
    const body = dev.heartbeatMessage();
    const tampered = JSON.stringify({ ...body, version: 'v9.9.9' });
    const a = await dev.send(DEVICE_PATHS.heartbeat, body, { sendBody: tampered });
    expect(a.status).toBe(401);
    expect((a.body as any).error).toBe('bad-signature');
    // Signed by another key, as this device.
    const impostor = new SimDevice(t.url, { deviceId: dev.deviceId });
    expect((await impostor.heartbeat()).body).toMatchObject({ error: 'bad-signature' });
    // Signed for another path.
    const h = await dev.send(DEVICE_PATHS.state, dev.heartbeatMessage(), { keyId: dev.deviceId });
    expect(h.status).toBe(422); // the signature is good for /state; the body is not a state
  });

  it('refuses missing signature headers', async () => {
    const res = await fetch(t.url + DEVICE_PATHS.heartbeat, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dev.heartbeatMessage()) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe('unauthorized');
  });

  it('refuses a stale timestamp, and says the server time', async () => {
    const a = await dev.heartbeat({ timestamp: Math.floor(Date.now() / 1000) - 301 });
    expect(a.status).toBe(401);
    expect((a.body as any).error).toBe('stale-timestamp');
    expect(Math.abs(Date.parse((a.body as any).serverTime) - Date.now())).toBeLessThan(5000);
    expect((await dev.heartbeat({ timestamp: Math.floor(Date.now() / 1000) + 400 })).status).toBe(401);
    expect((await dev.heartbeat({ timestamp: Math.floor(Date.now() / 1000) - 250 })).status).toBe(200);
  });

  it('a device with a wrong clock corrects itself from the answer', async () => {
    const skewed = new SimDevice(t.url, { keys: dev.keys, deviceId: dev.deviceId });
    skewed.skewS = -3600;
    const a = await skewed.heartbeat();
    expect(a.status).toBe(200);
    expect(skewed.clockOffsetS).toBeGreaterThan(3500);
  });

  it('refuses a replayed nonce', async () => {
    const nonce = newNonce();
    expect((await dev.heartbeat({ nonce })).status).toBe(200);
    const again = await dev.heartbeat({ nonce });
    expect(again.status).toBe(401);
    expect((again.body as any).error).toBe('replayed-nonce');
    // An exact replay of the bytes (same timestamp, same signature) too.
    const body = JSON.stringify(dev.heartbeatMessage());
    const ts = dev.nowS();
    const n2 = newNonce();
    expect((await dev.send(DEVICE_PATHS.heartbeat, body, { nonce: n2, timestamp: ts })).status).toBe(200);
    expect((await dev.send(DEVICE_PATHS.heartbeat, body, { nonce: n2, timestamp: ts })).status).toBe(401);
  });

  it('refuses an unknown device', async () => {
    const ghost = new SimDevice(t.url, { deviceId: '00000000-0000-4000-8000-000000000000' });
    const a = await ghost.heartbeat();
    expect(a.status).toBe(401);
    expect((a.body as any).error).toBe('unknown-device');
    expect((await new SimDevice(t.url, { deviceId: 'not-a-uuid' }).heartbeat()).status).toBe(401);
  });

  it('refuses a protocol version it does not accept, and an invalid message', async () => {
    const a = await dev.send(DEVICE_PATHS.heartbeat, { ...dev.heartbeatMessage(), protocolVersion: 2 });
    expect(a.status).toBe(422);
    expect(a.body).toMatchObject({ error: 'unsupported-protocol', supportedVersions: [1] });
    const b = await dev.send(DEVICE_PATHS.heartbeat, { ...dev.heartbeatMessage(), uptimeS: -1 });
    expect(b.status).toBe(422);
    expect((b.body as any).issues[0].path).toBe('uptimeS');
    const c = await dev.send(DEVICE_PATHS.heartbeat, '{not json');
    expect(c.status).toBe(400);
  });

  it('stores the state and the events, once per event id', async () => {
    const s = await dev.state();
    expect(s.status).toBe(200);
    const ev = [SimDevice.event({ severity: 'warning', kind: 'charger-offline', chargerId: 'cp-02', message: 'cp-02 offline' }), SimDevice.event({ severity: 'warning', kind: 'no-flow' })];
    const first = await dev.events(ev);
    expect(first.body.events).toEqual({ accepted: 2, duplicates: 0 });
    const again = await dev.events([...ev, SimDevice.event({ severity: 'warning' })]);
    expect(again.body.events).toEqual({ accepted: 1, duplicates: 2 });
    const list = await t.admin.get(`/api/devices/${dev.deviceId}/events`);
    expect(list.body).toHaveLength(3);
    const d = await t.admin.get(`/api/devices/${dev.deviceId}`);
    expect(d.body.lastState.chargers).toHaveLength(4);
    expect(d.body.controlMode).toBe('normal');
    expect(d.body.healthOk).toBe(true);
  });

  it('refuses a revoked device with 403', async () => {
    const { dev: victim } = await t.enrolledDevice();
    expect((await victim.heartbeat()).status).toBe(200);
    const r = await t.admin.post(`/api/devices/${victim.deviceId}/revoke`, { reason: 'stolen' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'revoked', presence: 'revoked', revokeReason: 'stolen' });
    const a = await victim.heartbeat();
    expect(a.status).toBe(403);
    expect((a.body as any).error).toBe('device-revoked');
    expect((await t.admin.post(`/api/devices/${victim.deviceId}/revoke`, { reason: 'again' })).status).toBe(409);
  });
});
