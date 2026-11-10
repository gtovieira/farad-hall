// Claim codes: create one for a site (shown once, big), list them, revoke an unused one.
import { useState } from 'react';
import { del, get, post, type ClaimCode, type Site } from '../api.js';
import { dateTime } from '../format.js';
import { useI18n, type Key } from '../i18n.js';
import { Link } from '../router.js';
import { codeTone } from '../status.js';
import { Badge, Button, Dialog, Empty, ErrorBox, Field, Form, PageHead, useLoad } from '../ui.js';

/** Creates a code for a site (chosen here, or given) and shows it once. */
export function NewClaimCode({ siteId, onClose }: { siteId?: string; onClose: (created: boolean) => void }) {
  const { t, locale } = useI18n();
  const sites = useLoad(() => (siteId ? Promise.resolve([] as Site[]) : get<Site[]>('/api/sites')), [siteId]);
  const [site, setSite] = useState(siteId ?? '');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<ClaimCode | null>(null);
  if (created) {
    return (
      <Dialog title={t('codes.created')} onClose={() => onClose(true)}>
        <div className="code-big" data-testid="claim-code">{created.code}</div>
        <p className="muted">{t('codes.createdHint')}</p>
        <div className="mono muted">
          {created.site.name} · {created.customer.name} · {t('col.expires')} {dateTime(created.expiresAt, locale)}
        </div>
        <div className="form-actions">
          <Button onClick={() => onClose(true)}>{t('form.done')}</Button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title={t('codes.new')} onClose={() => onClose(false)}>
      <Form
        onSubmit={async () => setCreated(await post<ClaimCode>('/api/claim-codes', { siteId: site, label: label || undefined }))}
        actions={(busy) => (
          <>
            <Button variant="ghost" onClick={() => onClose(false)}>{t('form.cancel')}</Button>
            <Button type="submit" disabled={busy || !site}>{t('codes.new')}</Button>
          </>
        )}
      >
        {!siteId ? (
          <Field label={t('codes.site')}>
            <select required value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="" />
              {(sites.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.customer.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label={t('codes.labelField')}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </Form>
    </Dialog>
  );
}

export function ClaimCodesPage() {
  const { t, locale } = useI18n();
  const { data, error, reload } = useLoad(() => get<ClaimCode[]>('/api/claim-codes'), []);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead label={t('codes.label')} title={t('codes.title')} actions={<Button onClick={() => setCreating(true)}>{t('codes.new')}</Button>} />
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      {data && data.length === 0 ? <Empty title={t('codes.empty')} /> : null}
      {data?.length ? (
        <section className="card flush">
          <div className="table-wrap">
            <table className="ftable">
              <thead>
                <tr>
                  <th>{t('col.code')}</th>
                  <th>{t('col.status')}</th>
                  <th>{t('col.site')}</th>
                  <th>{t('col.customer')}</th>
                  <th>{t('col.created')}</th>
                  <th>{t('col.expires')}</th>
                  <th>{t('col.device')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id}>
                    <td className="strong">{c.hint}</td>
                    <td>
                      <Badge tone={codeTone[c.status]}>{t(`codes.${c.status}` as Key)}</Badge>
                    </td>
                    <td>{c.site.name}</td>
                    <td>{c.customer.name}</td>
                    <td>
                      {dateTime(c.createdAt, locale)}
                      {c.label ? <div className="muted">{c.label}</div> : null}
                    </td>
                    <td>{dateTime(c.expiresAt, locale)}</td>
                    <td>{c.device ? <Link to={`/devices/${c.device.id}`}>{c.device.name}</Link> : '—'}</td>
                    <td>
                      {c.status === 'active' ? (
                        <Button size="sm" variant="ghost" onClick={() => void del(`/api/claim-codes/${c.id}`).then(reload)}>
                          {t('codes.revoke')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {creating ? (
        <NewClaimCode
          onClose={(made) => {
            setCreating(false);
            if (made) reload();
          }}
        />
      ) : null}
    </>
  );
}
