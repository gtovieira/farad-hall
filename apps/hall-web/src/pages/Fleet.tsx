// The fleet: every device, its presence, site, customer, version, last message, public IP, alerts.
import { useMemo, useState } from 'react';
import { get, type Fleet, type FleetDevice } from '../api.js';
import { ago } from '../format.js';
import { useI18n } from '../i18n.js';
import { navigate } from '../router.js';
import { modeKey, modeTone, presenceKey, presenceTone } from '../status.js';
import { Badge, Empty, ErrorBox, PageHead, Stat, StatusDot, useLoad } from '../ui.js';

export function matches(d: FleetDevice, q: string): boolean {
  if (!q) return true;
  const hay = [d.name, d.site.name, d.customer.name, d.reseller?.name, d.version, d.publicIp, d.lanIp].filter(Boolean).join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export function FleetTable({ devices }: { devices: FleetDevice[] }) {
  const { t, locale } = useI18n();
  return (
    <div className="table-wrap">
      <table className="ftable" aria-label={t('fleet.title')}>
        <thead>
          <tr>
            <th>{t('col.status')}</th>
            <th>{t('col.site')}</th>
            <th>{t('col.customer')}</th>
            <th>{t('col.version')}</th>
            <th>{t('col.lastSeen')}</th>
            <th>{t('col.publicIp')}</th>
            <th>{t('col.control')}</th>
            <th>{t('col.alerts')}</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} data-clickable onClick={() => navigate(`/devices/${d.id}`)}>
              <td>
                <StatusDot tone={presenceTone[d.presence]} label={t(presenceKey(d.presence))} />
              </td>
              <td className="strong">
                <a href={`/devices/${d.id}`} onClick={(e) => e.preventDefault()}>
                  {d.site.name}
                </a>
                <div className="muted">{d.name}</div>
              </td>
              <td>{d.customer.name}</td>
              <td>{d.version ?? '—'}</td>
              <td title={d.lastSeenAt ?? ''}>{ago(d.lastSeenAt, locale)}</td>
              <td>{d.publicIp ?? '—'}</td>
              <td>{d.controlMode ? <StatusDot tone={modeTone(d.controlMode)} label={t(modeKey(d.controlMode))} /> : '—'}</td>
              <td>
                {d.openAlerts ? (
                  <Badge tone={d.criticalAlerts ? 'err' : 'warn'}>
                    {d.openAlerts} · {t(d.criticalAlerts ? 'sev.critical' : 'sev.warning')}
                  </Badge>
                ) : (
                  <span className="muted">0</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FleetPage() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const { data, error, reload } = useLoad(() => get<Fleet>('/api/fleet'), [], 15_000);
  const devices = useMemo(() => (data?.devices ?? []).filter((d) => matches(d, q)), [data, q]);
  return (
    <>
      <PageHead label={t('fleet.label')} title={t('fleet.title')} />
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      {data ? (
        <>
          <div className="stats">
            <Stat label={t('fleet.total')} value={data.summary.total} />
            <Stat label={t('fleet.online')} value={data.summary.online} tone="ok" />
            <Stat label={t('fleet.offline')} value={data.summary.offline} tone={data.summary.offline ? 'warn' : undefined} />
            <Stat label={t('fleet.openAlerts')} value={data.summary.openAlerts} tone={data.summary.openAlerts ? 'err' : undefined} />
          </div>
          <input className="search" type="search" placeholder={t('fleet.search')} aria-label={t('fleet.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          {data.devices.length === 0 ? (
            <Empty title={t('fleet.empty')}>{t('fleet.emptyHint')}</Empty>
          ) : (
            <section className="card flush">
              <FleetTable devices={devices} />
            </section>
          )}
        </>
      ) : null}
    </>
  );
}
