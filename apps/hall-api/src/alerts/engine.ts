// Alerts, first rule set:
//
// - device-offline: no message from an active device for more than N minutes (settings); closes by
//   itself at the next message.
// - control-fallback: the state says the control is in fallback (fallback-analyzer, fallback-error);
//   closes by itself when a state says it is not.
// - critical-event: the device sent a critical event; one alert per event kind (and charger), a
//   repeat counts on it; closed by a person.
//
// An alert is open, then acknowledged (someone is on it), then closed. At most one alert of a rule
// and key per device is not closed (a unique index), so a repeat never opens a second one.
// Changes run in the caller's transaction (the telemetry and its alerts commit together); e-mails
// go out after the commit, best effort.
import type { v1 } from '@hall/protocol';
import { audit, SYSTEM } from '../audit.js';
import type { Config } from '../config.js';
import type { Db, Queryable } from '../db.js';
import { getAlertSettings } from '../settings.js';
import type { Mailer } from './mail.js';

export type AlertRule = 'device-offline' | 'control-fallback' | 'critical-event';
export type AlertSeverity = 'warning' | 'critical';

export interface Notice {
  kind: 'opened' | 'closed';
  alertId: string;
}

interface Raise {
  deviceId: string;
  siteId: string;
  rule: AlertRule;
  dedupKey?: string;
  severity: AlertSeverity;
  title: string;
  details: Record<string, unknown>;
  at: Date;
}

const FALLBACK_MODES = new Set<v1.ControlMode>(['fallback-analyzer', 'fallback-error']);

export interface EngineDeps {
  db: Db;
  config: Config;
  mailer: Mailer;
  now: () => Date;
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

export class AlertEngine {
  private pending = new Set<Promise<void>>();

  constructor(private readonly d: EngineDeps) {}

  /** Opens an alert, or counts a repeat on the one already open. */
  async raise(on: Queryable, a: Raise): Promise<Notice[]> {
    const row = await this.d.db.one<{ id: string; inserted: boolean }>(
      `INSERT INTO alerts (device_id, site_id, rule, dedup_key, severity, title, details, opened_at, last_occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (device_id, rule, dedup_key) WHERE status <> 'closed'
       DO UPDATE SET occurrences = alerts.occurrences + 1, last_occurred_at = EXCLUDED.last_occurred_at, details = EXCLUDED.details
       RETURNING id, (xmax = 0) AS inserted`,
      [a.deviceId, a.siteId, a.rule, a.dedupKey ?? '', a.severity, a.title, JSON.stringify(a.details), a.at],
      on,
    );
    if (!row?.inserted) return [];
    await audit(this.d.db, on, SYSTEM, { action: 'alert.open', entityType: 'alert', entityId: row.id, after: { rule: a.rule, deviceId: a.deviceId, title: a.title } });
    return [{ kind: 'opened', alertId: row.id }];
  }

  /** Closes the device's alerts of a rule that are not closed (the condition is gone). */
  async resolve(on: Queryable, deviceId: string, rule: AlertRule, at: Date): Promise<Notice[]> {
    const rows = await this.d.db.query<{ id: string }>(
      `UPDATE alerts SET status = 'closed', closed_at = $3, close_reason = 'auto'
        WHERE device_id = $1 AND rule = $2 AND status <> 'closed' RETURNING id`,
      [deviceId, rule, at],
      on,
    );
    for (const r of rows) await audit(this.d.db, on, SYSTEM, { action: 'alert.auto-close', entityType: 'alert', entityId: r.id, after: { rule, deviceId } });
    return rows.map((r) => ({ kind: 'closed', alertId: r.id }));
  }

  /** Any message from a device: it is not offline. */
  onMessage(on: Queryable, device: { id: string }, at: Date): Promise<Notice[]> {
    return this.resolve(on, device.id, 'device-offline', at);
  }

  async onState(on: Queryable, device: { id: string; siteId: string }, state: v1.DeviceState, at: Date): Promise<Notice[]> {
    if (FALLBACK_MODES.has(state.control.mode)) {
      return this.raise(on, {
        deviceId: device.id,
        siteId: device.siteId,
        rule: 'control-fallback',
        severity: 'critical',
        title: state.control.mode === 'fallback-analyzer' ? 'Controle em fallback: medidor principal perdido' : 'Controle em fallback: controle degradado',
        details: { mode: state.control.mode, mainMeterOnline: state.control.mainMeterOnline, since: state.control.since ?? null },
        at,
      });
    }
    return this.resolve(on, device.id, 'control-fallback', at);
  }

  /** The events just stored (not the duplicates). */
  async onEvents(on: Queryable, device: { id: string; siteId: string }, events: v1.DeviceEvent[], at: Date): Promise<Notice[]> {
    const out: Notice[] = [];
    for (const e of events) {
      if (e.severity !== 'critical') continue;
      out.push(
        ...(await this.raise(on, {
          deviceId: device.id,
          siteId: device.siteId,
          rule: 'critical-event',
          dedupKey: `${e.kind}:${e.chargerId ?? ''}`,
          severity: 'critical',
          title: `Evento crítico: ${e.kind}${e.chargerId ? ` (${e.chargerId})` : ''}`,
          details: { eventId: e.id, kind: e.kind, message: e.message, source: e.source, chargerId: e.chargerId ?? null, timestamp: e.timestamp },
          at,
        })),
      );
    }
    return out;
  }

  /** Opens device-offline for every active device silent for longer than the setting. */
  async checkOffline(now: Date = this.d.now()): Promise<number> {
    const notices = await this.d.db.tx(async (tx) => {
      // One API process at a time runs the check.
      const lock = await this.d.db.one<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(7470002) AS ok', [], tx);
      if (!lock?.ok) return [];
      const { offlineAfterMin } = await getAlertSettings(this.d.db, this.d.config, tx);
      const silent = await this.d.db.query<{ id: string; site_id: string; last_seen_at: Date }>(
        `SELECT d.id, d.site_id, d.last_seen_at FROM devices d
          WHERE d.status = 'active' AND d.last_seen_at < $1::timestamptz - make_interval(mins => $2)
            AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.device_id = d.id AND a.rule = 'device-offline' AND a.status <> 'closed')`,
        [now, offlineAfterMin],
        tx,
      );
      const out: Notice[] = [];
      for (const d of silent) {
        out.push(
          ...(await this.raise(tx, {
            deviceId: d.id,
            siteId: d.site_id,
            rule: 'device-offline',
            severity: 'critical',
            title: `Equipamento off-line há mais de ${offlineAfterMin} min`,
            details: { lastSeenAt: d.last_seen_at.toISOString(), offlineAfterMin },
            at: now,
          })),
        );
      }
      return out;
    });
    this.deliver(notices);
    return notices.length;
  }

  /** Sends the e-mails of these notices, after the transaction committed. Does not throw. */
  deliver(notices: Notice[]): void {
    for (const n of notices) {
      const p = this.send(n)
        .catch((err: Error) => this.d.log.error({ err: err.message, alertId: n.alertId }, 'alert e-mail failed'))
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  /** Resolves when every e-mail started so far is done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async send(n: Notice): Promise<void> {
    const settings = await getAlertSettings(this.d.db, this.d.config);
    if (!settings.emailEnabled || settings.recipients.length === 0) return;
    if (n.kind === 'closed' && !settings.notifyResolved) return;
    const a = await this.d.db.one<{
      id: string;
      title: string;
      severity: AlertSeverity;
      rule: AlertRule;
      opened_at: Date;
      closed_at: Date | null;
      details: Record<string, unknown>;
      device_id: string;
      device_name: string;
      site_name: string;
      customer_name: string;
    }>(
      `SELECT a.id, a.title, a.severity, a.rule, a.opened_at, a.closed_at, a.details, d.id AS device_id, d.name AS device_name,
              s.name AS site_name, c.legal_name AS customer_name
         FROM alerts a JOIN devices d ON d.id = a.device_id JOIN sites s ON s.id = a.site_id JOIN customers c ON c.id = s.customer_id
        WHERE a.id = $1`,
      [n.alertId],
    );
    if (!a) return;
    const opened = n.kind === 'opened';
    const link = this.d.config.publicUrl ? `${this.d.config.publicUrl}/devices/${a.device_id}` : `/devices/${a.device_id}`;
    const subject = `[Farad Hall] ${opened ? (a.severity === 'critical' ? 'CRÍTICO' : 'AVISO') : 'RESOLVIDO'} · ${a.title} · ${a.site_name}`;
    const text = [
      opened ? `Alerta aberto: ${a.title}` : `Alerta resolvido: ${a.title}`,
      '',
      `Local: ${a.site_name}`,
      `Cliente: ${a.customer_name}`,
      `Equipamento: ${a.device_name}`,
      `Aberto em: ${a.opened_at.toISOString()}`,
      ...(a.closed_at ? [`Fechado em: ${a.closed_at.toISOString()}`] : []),
      `Regra: ${a.rule}`,
      '',
      ...Object.entries(a.details).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
      '',
      link,
    ].join('\n');
    await this.d.mailer.send({ to: settings.recipients, subject, text });
    if (opened) await this.d.db.query('UPDATE alerts SET notified_at = $2 WHERE id = $1', [a.id, this.d.now()]);
    this.d.log.info({ alertId: a.id, kind: n.kind, to: settings.recipients.length }, 'alert e-mail sent');
  }
}
