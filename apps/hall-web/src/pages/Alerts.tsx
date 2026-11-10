// Alerts: the active ones, to acknowledge (someone is on it) and close (with a note).
import { useState } from 'react';
import { get, post, type Alert } from '../api.js';
import { useAuth } from '../auth.js';
import { ago, dateTime } from '../format.js';
import { useI18n, type Key } from '../i18n.js';
import { Link } from '../router.js';
import { severityTone } from '../status.js';
import { Badge, Button, Card, Dialog, Empty, ErrorBox, Field, Form, PageHead, useLoad } from '../ui.js';

export function AlertList({ alerts, onChange, showDevice = true }: { alerts: Alert[]; onChange: () => void; showDevice?: boolean }) {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const [acting, setActing] = useState<{ alert: Alert; action: 'acknowledge' | 'close' } | null>(null);
  const [note, setNote] = useState('');
  return (
    <div>
      {alerts.map((a) => (
        <div className="alert-row" key={a.id}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge tone={severityTone(a.severity)}>{t(`sev.${a.severity}` as Key)}</Badge>
              <Badge tone={a.status === 'open' ? 'err' : a.status === 'acknowledged' ? 'volt' : 'off'}>{t(`alert.${a.status}` as Key)}</Badge>
              <span className="alert-title">{a.title}</span>
              {a.occurrences > 1 ? <span className="muted mono">{t('alert.times', { n: a.occurrences })}</span> : null}
            </div>
            <div className="alert-meta">
              {t(`alert.${a.rule}` as Key)} · {dateTime(a.openedAt, locale)} · {ago(a.lastOccurredAt, locale)}
              {showDevice ? (
                <>
                  {' · '}
                  <Link to={`/devices/${a.device.id}`}>{a.site.name}</Link> · {a.customer.name}
                </>
              ) : null}
              {a.acknowledgedBy ? ` · ${a.acknowledgedBy}${a.ackNote ? `: ${a.ackNote}` : ''}` : ''}
            </div>
          </div>
          {can('alerts:manage') && a.status !== 'closed' ? (
            <div className="row-actions">
              {a.status === 'open' ? (
                <Button size="sm" variant="secondary" onClick={() => setActing({ alert: a, action: 'acknowledge' })}>
                  {t('alert.acknowledge')}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setActing({ alert: a, action: 'close' })}>
                {t('alert.close')}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {acting ? (
        <Dialog title={`${t(acting.action === 'close' ? 'alert.close' : 'alert.acknowledge')} · ${acting.alert.title}`} onClose={() => setActing(null)}>
          <Form
            onSubmit={async () => {
              await post(`/api/alerts/${acting.alert.id}/${acting.action}`, { note: note || undefined });
              setActing(null);
              setNote('');
              onChange();
            }}
            actions={(busy) => (
              <>
                <Button variant="ghost" onClick={() => setActing(null)}>{t('form.cancel')}</Button>
                <Button type="submit" disabled={busy}>{t(acting.action === 'close' ? 'alert.close' : 'alert.acknowledge')}</Button>
              </>
            )}
          >
            <Field label={t('alert.note')}>
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </Form>
        </Dialog>
      ) : null}
    </div>
  );
}

export function AlertsPage() {
  const { t } = useI18n();
  const { data, error, reload } = useLoad(() => get<Alert[]>('/api/alerts?active=true'), [], 15_000);
  return (
    <>
      <PageHead label={t('alerts.label')} title={t('alerts.title')} />
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      {data ? data.length ? <Card><AlertList alerts={data} onChange={reload} /></Card> : <Empty title={t('alerts.empty')} /> : null}
    </>
  );
}
