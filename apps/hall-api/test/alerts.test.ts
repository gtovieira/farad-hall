// The first alert rules: offline, control in fallback, a critical event; their lifecycle and e-mails.
import { SimDevice } from '@hall/device-sim';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHall, type TestHall } from './helpers.js';

let t: TestHall;
beforeAll(async () => {
  t = await startHall();
  const put = await t.admin.put('/api/settings/alerts', { offlineAfterMin: 5, emailEnabled: true, recipients: ['noc@farad.test'], notifyResolved: true });
  expect(put.status).toBe(200);
});
afterAll(async () => t?.stop());
beforeEach(() => {
  t.mailer.sent.length = 0;
});

const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000);
const alertsOf = async (deviceId: string) => (await t.admin.get(`/api/alerts?deviceId=${deviceId}`)).body as any[];

describe('device offline', () => {
  it('opens after N minutes of silence, once, and closes at the next message', async () => {
    const { dev } = await t.enrolledDevice('Prédio Silencioso');
    await dev.heartbeat();
    // Not yet: 4 minutes.
    await t.hall.deps.alerts.checkOffline(minutesAhead(4));
    expect(await alertsOf(dev.deviceId!)).toHaveLength(0);
    // 6 minutes: open, critical, e-mailed.
    await t.hall.deps.alerts.checkOffline(minutesAhead(6));
    await t.hall.deps.alerts.checkOffline(minutesAhead(7));
    await t.hall.deps.alerts.idle();
    const open = await alertsOf(dev.deviceId!);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ rule: 'device-offline', status: 'open', severity: 'critical', site: { name: 'Prédio Silencioso' } });
    const mails = t.mailer.sent.filter((m) => m.text.includes('Prédio Silencioso'));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: ['noc@farad.test'] });
    expect(mails[0]!.subject).toMatch(/CRÍTICO · Equipamento off-line há mais de 5 min · Prédio Silencioso/);
    expect((await t.admin.get(`/api/devices/${dev.deviceId}`)).body.alerts[0].notifiedAt).not.toBeNull();

    // Back: closes by itself, with a "resolved" e-mail.
    await dev.heartbeat();
    await t.hall.deps.alerts.idle();
    const after = await alertsOf(dev.deviceId!);
    expect(after[0]).toMatchObject({ status: 'closed', closeReason: 'auto' });
    expect(t.mailer.sent.some((m) => m.subject.startsWith('[Farad Hall] RESOLVIDO'))).toBe(true);
  });

  it('follows the threshold in the settings', async () => {
    const { dev } = await t.enrolledDevice();
    await dev.heartbeat();
    await t.admin.put('/api/settings/alerts', { offlineAfterMin: 30, emailEnabled: false, recipients: [], notifyResolved: false });
    try {
      await t.hall.deps.alerts.checkOffline(minutesAhead(10));
      expect(await alertsOf(dev.deviceId!)).toHaveLength(0);
      await t.hall.deps.alerts.checkOffline(minutesAhead(31));
      await t.hall.deps.alerts.idle();
      expect(await alertsOf(dev.deviceId!)).toHaveLength(1);
      expect(t.mailer.sent).toHaveLength(0);
    } finally {
      await t.admin.put('/api/settings/alerts', { offlineAfterMin: 5, emailEnabled: true, recipients: ['noc@farad.test'], notifyResolved: true });
    }
    const audit = await t.admin.get('/api/audit?entityType=settings');
    expect(audit.body[0]).toMatchObject({ action: 'settings.alerts', after: { offlineAfterMin: 5 } });
  });

  it('never alerts a revoked device', async () => {
    const { dev } = await t.enrolledDevice();
    await t.admin.post(`/api/devices/${dev.deviceId}/revoke`, { reason: 'returned' });
    await t.hall.deps.alerts.checkOffline(minutesAhead(60));
    expect(await alertsOf(dev.deviceId!)).toHaveLength(0);
  });
});

describe('control in fallback', () => {
  it('opens on a fallback state and closes when the control is back', async () => {
    const { dev } = await t.enrolledDevice('Prédio Fallback');
    dev.profile.controlMode = 'fallback-analyzer';
    await dev.state();
    await dev.state();
    let a = await alertsOf(dev.deviceId!);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ rule: 'control-fallback', status: 'open', occurrences: 2, details: { mode: 'fallback-analyzer', mainMeterOnline: false } });
    expect((await t.admin.get('/api/fleet')).body.devices.find((d: any) => d.id === dev.deviceId)).toMatchObject({ controlMode: 'fallback-analyzer', openAlerts: 1, criticalAlerts: 1 });
    dev.profile.controlMode = 'normal';
    await dev.state();
    a = await alertsOf(dev.deviceId!);
    expect(a[0]).toMatchObject({ status: 'closed', closeReason: 'auto' });
    // no-settings is commissioning, not fallback.
    dev.profile.controlMode = 'no-settings';
    await dev.state();
    expect((await alertsOf(dev.deviceId!)).filter((x) => x.status !== 'closed')).toHaveLength(0);
  });
});

describe('critical events', () => {
  it('opens one alert per kind, counts repeats, ignores warnings and duplicates', async () => {
    const { dev } = await t.enrolledDevice('Prédio Crítico');
    const e1 = SimDevice.event({ kind: 'invariant-violated' });
    await dev.events([e1, SimDevice.event({ kind: 'invariant-violated' }), SimDevice.event({ severity: 'warning', kind: 'no-flow' })]);
    await dev.events([e1]); // a resent batch
    await dev.events([SimDevice.event({ kind: 'analyzer-lost' })]);
    const a = await alertsOf(dev.deviceId!);
    expect(a.map((x) => [x.rule, x.details.kind, x.occurrences]).sort()).toEqual([
      ['critical-event', 'analyzer-lost', 1],
      ['critical-event', 'invariant-violated', 2],
    ]);
  });

  it('is acknowledged, then closed by a person, with notes in the audit log', async () => {
    const { dev } = await t.enrolledDevice();
    await dev.events([SimDevice.event({ kind: 'charger-blocked', chargerId: 'cp-03' })]);
    const [alert] = await alertsOf(dev.deviceId!);
    expect(alert.title).toBe('Evento crítico: charger-blocked (cp-03)');
    const ack = await t.admin.post(`/api/alerts/${alert.id}/acknowledge`, { note: 'técnico a caminho' });
    expect(ack.body).toMatchObject({ status: 'acknowledged', ackNote: 'técnico a caminho', acknowledgedBy: 'admin@farad.test' });
    expect((await t.admin.post(`/api/alerts/${alert.id}/acknowledge`, {})).status).toBe(409);
    // A repeat while acknowledged counts on it.
    await dev.events([SimDevice.event({ kind: 'charger-blocked', chargerId: 'cp-03' })]);
    expect((await alertsOf(dev.deviceId!))[0]).toMatchObject({ status: 'acknowledged', occurrences: 2 });
    const close = await t.admin.post(`/api/alerts/${alert.id}/close`, { note: 'carregador trocado' });
    expect(close.body).toMatchObject({ status: 'closed', closeReason: 'manual', closeNote: 'carregador trocado' });
    expect((await t.admin.post(`/api/alerts/${alert.id}/close`, {})).status).toBe(409);
    // A new occurrence after closing opens a new alert.
    await dev.events([SimDevice.event({ kind: 'charger-blocked', chargerId: 'cp-03' })]);
    expect((await alertsOf(dev.deviceId!)).filter((x) => x.status === 'open')).toHaveLength(1);
    const audit = await t.admin.get(`/api/audit?entityType=alert&entityId=${alert.id}`);
    expect(audit.body.map((e: any) => e.action)).toEqual(['alert.close', 'alert.acknowledge', 'alert.open']);
    expect((await t.admin.get('/api/alerts?active=true')).body.every((x: any) => x.status !== 'closed')).toBe(true);
  });

  it('a failing mail server never fails the device request', async () => {
    const { dev } = await t.enrolledDevice();
    t.mailer.failNext = true;
    const a = await dev.events([SimDevice.event({ kind: 'module-crashed' })]);
    expect(a.status).toBe(200);
    await t.hall.deps.alerts.idle();
    expect((await alertsOf(dev.deviceId!))[0].notifiedAt).toBeNull();
  });
});
