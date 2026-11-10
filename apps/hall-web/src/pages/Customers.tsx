// Customers: the list, and a new one (legal name, CNPJ or CPF, city, reseller).
import { useState } from 'react';
import { get, post, type Customer, type Reseller } from '../api.js';
import { useAuth } from '../auth.js';
import { taxId } from '../format.js';
import { useI18n } from '../i18n.js';
import { navigate } from '../router.js';
import { Button, Dialog, Empty, ErrorBox, Field, Form, PageHead, useLoad } from '../ui.js';

function NewCustomer({ onClose }: { onClose: (id?: string) => void }) {
  const { t } = useI18n();
  const resellers = useLoad(() => get<Reseller[]>('/api/resellers'), []);
  const [f, setF] = useState({ legalName: '', tradeName: '', document: '', city: '', state: '', resellerId: '', contactName: '', contactEmail: '', contactPhone: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog title={t('customers.new')} onClose={() => onClose()}>
      <Form
        onSubmit={async () => {
          const c = await post<Customer>('/api/customers', {
            legalName: f.legalName,
            tradeName: f.tradeName || null,
            document: f.document,
            resellerId: f.resellerId || null,
            address: { city: f.city || null, state: f.state ? f.state.toUpperCase() : null },
            contacts: f.contactName ? [{ name: f.contactName, email: f.contactEmail || null, phone: f.contactPhone || null }] : [],
          });
          onClose(c.id);
        }}
        actions={(busy) => (
          <>
            <Button variant="ghost" onClick={() => onClose()}>{t('form.cancel')}</Button>
            <Button type="submit" disabled={busy}>{t('form.create')}</Button>
          </>
        )}
      >
        <Field label={t('customer.legalName')}>
          <input required value={f.legalName} onChange={set('legalName')} />
        </Field>
        <div className="form-row">
          <Field label={t('customer.tradeName')}>
            <input value={f.tradeName} onChange={set('tradeName')} />
          </Field>
          <Field label={t('customer.document')}>
            <input required value={f.document} onChange={set('document')} placeholder="00.000.000/0000-00" />
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('customer.city')}>
            <input value={f.city} onChange={set('city')} />
          </Field>
          <Field label={t('customer.state')}>
            <input value={f.state} onChange={set('state')} maxLength={2} placeholder="BA" />
          </Field>
          <Field label={t('customer.reseller')}>
            <select value={f.resellerId} onChange={set('resellerId')}>
              <option value="">{t('customer.noReseller')}</option>
              {(resellers.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('customer.contact')}>
            <input value={f.contactName} onChange={set('contactName')} />
          </Field>
          <Field label={t('customer.email')}>
            <input type="email" value={f.contactEmail} onChange={set('contactEmail')} />
          </Field>
          <Field label={t('customer.phone')}>
            <input value={f.contactPhone} onChange={set('contactPhone')} />
          </Field>
        </div>
      </Form>
    </Dialog>
  );
}

export function CustomersPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { data, error, reload } = useLoad(() => get<Customer[]>('/api/customers'), []);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead label={t('customers.label')} title={t('customers.title')} actions={can('org:write') ? <Button onClick={() => setCreating(true)}>{t('customers.new')}</Button> : null} />
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      {data && data.length === 0 ? <Empty title={t('customers.empty')} /> : null}
      {data?.length ? (
        <section className="card flush">
          <div className="table-wrap">
            <table className="ftable">
              <thead>
                <tr>
                  <th>{t('col.customer')}</th>
                  <th>{t('col.document')}</th>
                  <th>{t('col.city')}</th>
                  <th>{t('col.reseller')}</th>
                  <th className="num">{t('col.sites')}</th>
                  <th className="num">{t('col.devices')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id} data-clickable onClick={() => navigate(`/customers/${c.id}`)}>
                    <td className="strong">
                      {c.legalName}
                      {c.tradeName ? <div className="muted">{c.tradeName}</div> : null}
                    </td>
                    <td>{taxId(c.document)}</td>
                    <td>{[c.address.city, c.address.state].filter(Boolean).join(' · ') || '—'}</td>
                    <td>{c.reseller?.name ?? 'Farad'}</td>
                    <td className="num">{c.siteCount}</td>
                    <td className="num">{c.deviceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {creating ? (
        <NewCustomer
          onClose={(id) => {
            setCreating(false);
            if (id) navigate(`/customers/${id}`);
          }}
        />
      ) : null}
    </>
  );
}
