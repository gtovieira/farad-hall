// One customer: who it is, its sites (add one, generate a claim code for one) and its devices.
import { useState } from 'react';
import { get, post, type Customer, type Fleet, type Site, type SiteKind } from '../api.js';
import { useAuth } from '../auth.js';
import { taxId } from '../format.js';
import { useI18n, type Key } from '../i18n.js';
import { Link } from '../router.js';
import { Button, Card, Dialog, Empty, ErrorBox, Facts, Field, Form, PageHead, useLoad } from '../ui.js';
import { NewClaimCode } from './ClaimCodes.js';
import { FleetTable } from './Fleet.js';

const KINDS: SiteKind[] = ['condominio', 'eletroposto', 'empresa', 'estacionamento'];

function NewSite({ customerId, onClose }: { customerId: string; onClose: (made: boolean) => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', kind: 'condominio' as SiteKind, utility: '', city: '', state: '' });
  return (
    <Dialog title={t('site.new')} onClose={() => onClose(false)}>
      <Form
        onSubmit={async () => {
          await post('/api/sites', { customerId, name: f.name, kind: f.kind, utility: f.utility || null, address: { city: f.city || null, state: f.state ? f.state.toUpperCase() : null } });
          onClose(true);
        }}
        actions={(busy) => (
          <>
            <Button variant="ghost" onClick={() => onClose(false)}>{t('form.cancel')}</Button>
            <Button type="submit" disabled={busy}>{t('form.create')}</Button>
          </>
        )}
      >
        <Field label={t('site.name')}>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="form-row">
          <Field label={t('site.kind')}>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as SiteKind })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>{t(`kind.${k}` as Key)}</option>
              ))}
            </select>
          </Field>
          <Field label={t('site.utility')}>
            <input value={f.utility} onChange={(e) => setF({ ...f, utility: e.target.value })} placeholder="Coelba" />
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('customer.city')}>
            <input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
          </Field>
          <Field label={t('customer.state')}>
            <input value={f.state} maxLength={2} onChange={(e) => setF({ ...f, state: e.target.value })} />
          </Field>
        </div>
      </Form>
    </Dialog>
  );
}

export function CustomerPage({ id }: { id: string }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const customer = useLoad(() => get<Customer>(`/api/customers/${id}`), [id]);
  const sites = useLoad(() => get<Site[]>(`/api/sites?customerId=${id}`), [id]);
  const fleet = useLoad(() => get<Fleet>(`/api/fleet?customerId=${id}`), [id], 15_000);
  const [newSite, setNewSite] = useState(false);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const c = customer.data;
  if (customer.error) return <ErrorBox error={customer.error} onRetry={customer.reload} />;
  if (!c) return <div className="label">{t('app.loading')}</div>;
  return (
    <>
      <PageHead label={`${t('nav.customers')} · ${c.reseller?.name ?? 'Farad'}`} title={c.legalName} actions={can('org:write') ? <Button onClick={() => setNewSite(true)}>{t('site.new')}</Button> : null} />
      <Card>
        <Facts
          items={[
            [t('customer.tradeName'), c.tradeName],
            [t('customer.document'), taxId(c.document)],
            [t('customer.city'), [c.address.city, c.address.state].filter(Boolean).join(' · ') || null],
            [t('customer.contact'), c.contacts[0] ? [c.contacts[0].name, c.contacts[0].email, c.contacts[0].phone].filter(Boolean).join(' · ') : null],
          ]}
        />
      </Card>
      <Card title={t('customer.sites')} className="flush">
        {sites.data?.length ? (
          <div className="table-wrap">
            <table className="ftable">
              <thead>
                <tr>
                  <th>{t('col.site')}</th>
                  <th>{t('col.kind')}</th>
                  <th>{t('col.city')}</th>
                  <th>{t('site.utility')}</th>
                  <th className="num">{t('col.devices')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sites.data.map((s) => (
                  <tr key={s.id}>
                    <td className="strong">{s.name}</td>
                    <td>{t(`kind.${s.kind}` as Key)}</td>
                    <td>{[s.address.city, s.address.state].filter(Boolean).join(' · ') || '—'}</td>
                    <td>{s.utility ?? '—'}</td>
                    <td className="num">{s.deviceCount}</td>
                    <td>
                      {can('devices:manage') ? (
                        <Button size="sm" variant="secondary" onClick={() => setCodeFor(s.id)}>
                          {t('codes.new')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>
            <Empty title={t('customer.noSites')} />
          </div>
        )}
      </Card>
      {fleet.data?.devices.length ? (
        <Card title={t('col.devices')} className="flush">
          <FleetTable devices={fleet.data.devices} />
        </Card>
      ) : null}
      <div className="muted mono" style={{ fontSize: 'var(--text-2xs)' }}>
        <Link to="/customers">{t('nav.customers')}</Link>
      </div>
      {newSite ? (
        <NewSite
          customerId={id}
          onClose={(made) => {
            setNewSite(false);
            if (made) sites.reload();
          }}
        />
      ) : null}
      {codeFor ? <NewClaimCode siteId={codeFor} onClose={() => setCodeFor(null)} /> : null}
    </>
  );
}
