// One device: identity and network, presence over 24 h, its last state (control, services,
// resources, chargers), alerts and events; rename, revoke.
import { useState } from 'react';
import { get, patch, post, type DeviceDetail, type DeviceEventRow, type DevicePresence } from '../api.js';
import { useAuth } from '../auth.js';
import { ago, dateTime, duration, pct, time } from '../format.js';
import { useI18n, type Key } from '../i18n.js';
import { Link } from '../router.js';
import { connectorTone, modeKey, modeTone, presenceKey, presenceTone, severityTone } from '../status.js';
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Facts, Field, Form, PageHead, Stat, StatusDot, useLoad } from '../ui.js';
import { AlertList } from './Alerts.js';

/** 24 h of heartbeats in 5-minute buckets: full (every expected heartbeat), partial, none. */
export function PresenceStrip({ presence }: { presence: DevicePresence }) {
  const { t, locale } = useI18n();
  const level = (n: number) => (n >= presence.expectedPerBucket * 0.8 ? 'full' : n > 0 ? 'partial' : 'none');
  const first = presence.buckets[0];
  const mid = presence.buckets[Math.floor(presence.buckets.length / 2)];
  return (
    <div className="presence">
      <div className="presence-bars" role="img" aria-label={t('device.presence')}>
        {presence.buckets.map((b) => {
          const l = level(b.heartbeats);
          return <span key={b.start} className={l} style={{ height: l === 'none' ? '12%' : l === 'full' ? '100%' : `${Math.max(25, (b.heartbeats / presence.expectedPerBucket) * 100)}%` }} title={`${time(b.start, locale)} · ${b.heartbeats}/${presence.expectedPerBucket}`} />;
        })}
      </div>
      <div className="presence-axis">
        <span>{first ? time(first.start, locale) : ''}</span>
        <span>{mid ? time(mid.start, locale) : ''}</span>
        <span>{time(presence.to, locale)}</span>
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--ok)' }} />{t('device.presenceFull')}</span>
        <span><i style={{ background: 'var(--warn)' }} />{t('device.presencePartial')}</span>
        <span><i style={{ background: 'var(--line-1)' }} />{t('device.presenceNone')}</span>
      </div>
    </div>
  );
}

function StateView({ d }: { d: DeviceDetail }) {
  const { t, locale } = useI18n();
  const s = d.lastState;
  if (!s) return <Empty title={t('device.noState')} />;
  const temp = s.resources.temperatureC;
  return (
    <>
      <div className="stats">
        <Stat small label={t('col.control')} value={t(modeKey(s.control.mode))} tone={modeTone(s.control.mode)} sub={`${t('device.mainMeter')} · ${s.control.mainMeterOnline ? 'on-line' : 'off-line'}`} />
        <Stat label={t('device.cpu')} value={`${pct(s.resources.cpuPct, locale)} %`} />
        <Stat label={t('device.mem')} value={`${pct(s.resources.memPct, locale)} %`} />
        <Stat label={t('device.disk')} value={`${pct(s.resources.diskPct, locale)} %`} tone={s.resources.diskPct > 90 ? 'err' : undefined} sub={s.resources.diskFreeGb !== undefined ? `${s.resources.diskFreeGb} GB` : undefined} />
        <Stat label={t('device.temp')} value={temp === null ? '—' : `${pct(temp, locale)} °C`} tone={temp !== null && temp > 75 ? 'warn' : undefined} />
        <Stat label={t('device.sessions')} value={s.control.activeSessions ?? '—'} tone="volt" />
      </div>
      <div className="label">{t('device.services')}</div>
      <div className="services">
        {s.health.services.map((sv) => (
          <Badge key={sv.name} tone={sv.ok ? 'ok' : 'err'}>
            {sv.name}
          </Badge>
        ))}
      </div>
      <div className="label">{t('device.chargers')}</div>
      <div className="connectors">
        {s.chargers.flatMap((c) =>
          c.connectors.map((k) => (
            <div className="connector" key={`${c.chargerId}/${k.connectorId}`}>
              <span className="mono" style={{ color: 'var(--text-1)' }}>
                {c.chargerId}/{k.connectorId}
              </span>
              <StatusDot tone={c.online ? connectorTone(k.status) : 'off'} label={c.online ? (k.status ?? '—') : 'offline'} />
            </div>
          )),
        )}
      </div>
      <div className="muted mono" style={{ fontSize: 'var(--text-2xs)' }}>
        {t('device.lastState')} · {dateTime(d.lastStateAt, locale)}
      </div>
    </>
  );
}

export function DevicePage({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const dev = useLoad(() => get<DeviceDetail>(`/api/devices/${id}`), [id], 15_000);
  const presence = useLoad(() => get<DevicePresence>(`/api/devices/${id}/presence?hours=24`), [id], 60_000);
  const events = useLoad(() => get<DeviceEventRow[]>(`/api/devices/${id}/events?limit=50`), [id], 30_000);
  const [dialog, setDialog] = useState<'rename' | 'revoke' | null>(null);
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const d = dev.data;
  if (dev.error && !d) return <ErrorBox error={dev.error} onRetry={dev.reload} />;
  if (!d) return <div className="label">{t('app.loading')}</div>;
  const manage = can('devices:manage') && d.status === 'active';
  return (
    <>
      <PageHead
        label={`${d.customer.name} · ${d.name}`}
        title={
          <span style={{ display: 'inline-flex', gap: 'var(--sp-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            {d.site.name} <StatusDot tone={presenceTone[d.presence]} label={t(presenceKey(d.presence))} />
          </span>
        }
        actions={
          manage ? (
            <>
              <Button variant="secondary" onClick={() => { setName(d.name); setDialog('rename'); }}>{t('device.rename')}</Button>
              <Button variant="danger" onClick={() => setDialog('revoke')}>{t('device.revoke')}</Button>
            </>
          ) : null
        }
      />
      {d.revokedAt ? <div className="banner-revoked">{t('device.revoked', { at: dateTime(d.revokedAt, locale), reason: d.revokeReason ?? '' })}</div> : null}
      <div className="grid-2">
        <Card title={t('device.network')}>
          <Facts
            items={[
              [t('device.lastSeen'), `${ago(d.lastSeenAt, locale)} · ${dateTime(d.lastSeenAt, locale)}`],
              [t('col.publicIp'), d.publicIp],
              [t('col.lanIp'), d.lanIp],
              [t('device.uptime'), duration(d.uptimeS)],
            ]}
          />
        </Card>
        <Card title={t('device.identity')}>
          <Facts
            items={[
              [t('device.version'), d.version],
              [t('device.protocol'), d.protocolVersion ? `v${d.protocolVersion}` : null],
              [t('device.hostname'), d.hostname],
              [t('device.model'), d.model],
              [t('device.serial'), d.serial],
              [t('device.enrolled'), dateTime(d.enrolledAt, locale)],
              [t('device.image'), d.imageDigest ? `${d.imageDigest.slice(0, 19)}…` : null],
              [t('device.key'), `${d.publicKey.slice(0, 16)}…`],
            ]}
          />
        </Card>
      </div>
      <Card title={t('device.presence')}>{presence.data ? <PresenceStrip presence={presence.data} /> : presence.error ? <ErrorBox error={presence.error} /> : null}</Card>
      <Card title={t('device.alerts')}>{d.alerts.length ? <AlertList alerts={d.alerts} onChange={dev.reload} showDevice={false} /> : <span className="muted">{t('device.noAlerts')}</span>}</Card>
      <Card title={t('device.state')}>
        <StateView d={d} />
      </Card>
      <Card title={t('device.events')} className="flush">
        {events.data?.length ? (
          <div className="table-wrap">
            <table className="ftable">
              <thead>
                <tr>
                  <th>{t('col.when')}</th>
                  <th>{t('col.severity')}</th>
                  <th>{t('col.event')}</th>
                  <th>{t('col.charger')}</th>
                  <th>{t('col.message')}</th>
                </tr>
              </thead>
              <tbody>
                {events.data.map((e) => (
                  <tr key={e.id}>
                    <td>{dateTime(e.occurredAt, locale)}</td>
                    <td>
                      <Badge tone={severityTone(e.severity)}>{t(`sev.${e.severity}` as Key)}</Badge>
                    </td>
                    <td className="strong">{e.kind}</td>
                    <td>{e.chargerId ?? '—'}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: '0 var(--sp-4) var(--sp-4)' }} className="muted">
            {t('device.noEvents')}
          </div>
        )}
      </Card>
      <div className="muted mono" style={{ fontSize: 'var(--text-2xs)' }}>
        <Link to="/">{t('nav.fleet')}</Link> · {d.id}
      </div>
      {dialog === 'rename' ? (
        <Dialog title={t('device.rename')} onClose={() => setDialog(null)}>
          <Form
            onSubmit={async () => {
              await patch(`/api/devices/${id}`, { name });
              setDialog(null);
              dev.reload();
            }}
            actions={(busy) => (
              <>
                <Button variant="ghost" onClick={() => setDialog(null)}>{t('form.cancel')}</Button>
                <Button type="submit" disabled={busy}>{t('form.save')}</Button>
              </>
            )}
          >
            <Field label={t('device.name')}>
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </Form>
        </Dialog>
      ) : null}
      {dialog === 'revoke' ? (
        <Dialog title={t('device.revokeTitle')} onClose={() => setDialog(null)}>
          <p>{t('device.revokeText')}</p>
          <Form
            onSubmit={async () => {
              await post(`/api/devices/${id}/revoke`, { reason });
              setDialog(null);
              dev.reload();
            }}
            actions={(busy) => (
              <>
                <Button variant="ghost" onClick={() => setDialog(null)}>{t('form.cancel')}</Button>
                <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>{t('device.revoke')}</Button>
              </>
            )}
          >
            <Field label={t('device.revokeReason')}>
              <input required value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </Form>
        </Dialog>
      ) : null}
    </>
  );
}
