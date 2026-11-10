// The commercial tree: resellers › customers › sites (scope §4.8, minimal fields). Read within the
// person's scope; written at the Farad scope (admin-farad) in phase 1.
import { z } from 'zod';
import { actorOf, audit } from '../audit.js';
import { customerScopeSql, permitGlobal, scopeOf, siteScopeSql, type Permission } from '../auth/rbac.js';
import type { Deps, SessionUser } from '../context.js';
import type { Queryable } from '../db.js';
import { documentTypeOf } from '../documents.js';
import { forbidden, notFound } from '../http/errors.js';
import { defineRoute, type AnyRoute } from '../http/route.js';
import { Customer, CustomerInput, IdParams, Ok, Reseller, ResellerInput, Site, SiteInput, Uuid } from '../schemas.js';

type ResellerView = z.infer<typeof Reseller>;
type CustomerView = z.infer<typeof Customer>;
type SiteView = z.infer<typeof Site>;

// ------------------------------------------------------------------------------ readers --

interface ResellerRow {
  id: string;
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
  customer_count: number;
  created_at: Date;
  updated_at: Date;
}
const resellerView = (r: ResellerRow): ResellerView => ({
  id: r.id,
  name: r.name,
  document: r.document,
  email: r.email,
  phone: r.phone,
  customerCount: r.customer_count,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

async function resellers(deps: Deps, user: SessionUser, id?: string, on?: Queryable): Promise<ResellerView[]> {
  const scope = scopeOf(user, 'org:read')!;
  const params: unknown[] = [];
  let where = 'TRUE';
  if (!scope.all) {
    params.push(scope.resellerIds);
    where = `r.id = ANY($${params.length}::uuid[])`;
  }
  if (id) {
    params.push(id);
    where += ` AND r.id = $${params.length}`;
  }
  const rows = await deps.db.query<ResellerRow>(
    `SELECT r.*, (SELECT count(*) FROM customers c WHERE c.reseller_id = r.id) AS customer_count FROM resellers r WHERE ${where} ORDER BY lower(r.name)`,
    params,
    on,
  );
  return rows.map(resellerView);
}

interface CustomerRow {
  id: string;
  reseller_id: string | null;
  reseller_name: string | null;
  legal_name: string;
  trade_name: string | null;
  document_type: 'cnpj' | 'cpf';
  document: string;
  address: CustomerView['address'];
  contacts: CustomerView['contacts'];
  billing_contact: CustomerView['billingContact'];
  notes: string | null;
  site_count: number;
  device_count: number;
  created_at: Date;
  updated_at: Date;
}
const customerView = (r: CustomerRow): CustomerView => ({
  id: r.id,
  reseller: r.reseller_id ? { id: r.reseller_id, name: r.reseller_name ?? '' } : null,
  legalName: r.legal_name,
  tradeName: r.trade_name,
  documentType: r.document_type,
  document: r.document,
  address: r.address,
  contacts: r.contacts,
  billingContact: r.billing_contact,
  notes: r.notes,
  siteCount: r.site_count,
  deviceCount: r.device_count,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

async function customers(deps: Deps, user: SessionUser, filter: { id?: string; resellerId?: string; q?: string } = {}, on?: Queryable): Promise<CustomerView[]> {
  const params: unknown[] = [];
  const where = [customerScopeSql(scopeOf(user, 'org:read')!, params)];
  if (filter.id) where.push(`c.id = $${params.push(filter.id)}`);
  if (filter.resellerId) where.push(`c.reseller_id = $${params.push(filter.resellerId)}`);
  if (filter.q) where.push(`(c.legal_name ILIKE $${params.push(`%${filter.q}%`)} OR c.trade_name ILIKE $${params.length} OR c.document LIKE $${params.length})`);
  const rows = await deps.db.query<CustomerRow>(
    `SELECT c.*, r.name AS reseller_name,
            (SELECT count(*) FROM sites s WHERE s.customer_id = c.id) AS site_count,
            (SELECT count(*) FROM devices d JOIN sites s ON s.id = d.site_id WHERE s.customer_id = c.id AND d.status = 'active') AS device_count
       FROM customers c LEFT JOIN resellers r ON r.id = c.reseller_id
      WHERE ${where.join(' AND ')} ORDER BY lower(c.legal_name)`,
    params,
    on,
  );
  return rows.map(customerView);
}

interface SiteRow {
  id: string;
  customer_id: string;
  customer_name: string;
  reseller_id: string | null;
  reseller_name: string | null;
  name: string;
  kind: SiteView['kind'];
  address: SiteView['address'];
  utility: string | null;
  timezone: string;
  device_count: number;
  created_at: Date;
  updated_at: Date;
}
const siteView = (r: SiteRow): SiteView => ({
  id: r.id,
  customer: { id: r.customer_id, name: r.customer_name },
  reseller: r.reseller_id ? { id: r.reseller_id, name: r.reseller_name ?? '' } : null,
  name: r.name,
  kind: r.kind,
  address: r.address,
  utility: r.utility,
  timezone: r.timezone,
  deviceCount: r.device_count,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export async function sites(deps: Deps, user: SessionUser, filter: { id?: string; customerId?: string } = {}, on?: Queryable): Promise<SiteView[]> {
  const params: unknown[] = [];
  const where = [siteScopeSql(scopeOf(user, 'org:read')!, params)];
  if (filter.id) where.push(`s.id = $${params.push(filter.id)}`);
  if (filter.customerId) where.push(`s.customer_id = $${params.push(filter.customerId)}`);
  const rows = await deps.db.query<SiteRow>(
    `SELECT s.*, c.legal_name AS customer_name, c.reseller_id, r.name AS reseller_name,
            (SELECT count(*) FROM devices d WHERE d.site_id = s.id AND d.status = 'active') AS device_count
       FROM sites s JOIN customers c ON c.id = s.customer_id LEFT JOIN resellers r ON r.id = c.reseller_id
      WHERE ${where.join(' AND ')} ORDER BY lower(c.legal_name), lower(s.name)`,
    params,
    on,
  );
  return rows.map(siteView);
}

const one = <T>(list: T[], what: string): T => {
  if (!list[0]) throw notFound(what);
  return list[0];
};

// ------------------------------------------------------------------------------- routes --

const CustomerQuery = z.object({ resellerId: Uuid.optional(), q: z.string().max(100).optional().describe('Search the names and the document') });
const SiteQuery = z.object({ customerId: Uuid.optional() });

/** Writes the commercial tree: the Farad scope only (admin-farad) in phase 1. */
const writer = (user: SessionUser) => permitGlobal(user, 'org:write');

export function orgRoutes(): AnyRoute[] {
  const crud = <T>(entity: string, read: (deps: Deps, user: SessionUser, id: string, on?: Queryable) => Promise<T>) => ({ entity, read });
  const resellerCrud = crud('reseller', async (deps, user, id, on) => one(await resellers(deps, user, id, on), 'reseller'));
  const customerCrud = crud('customer', async (deps, user, id, on) => one(await customers(deps, user, { id }, on), 'customer'));
  const siteCrud = crud('site', async (deps, user, id, on) => one(await sites(deps, user, { id }, on), 'site'));

  return [
    // resellers
    defineRoute({
      method: 'GET',
      path: '/api/resellers',
      tag: 'org',
      summary: 'Resellers in your scope',
      auth: { perm: 'org:read' },
      responses: { 200: z.array(Reseller) },
      handler: ({ user, deps }) => resellers(deps, user),
    }),
    defineRoute({
      method: 'GET',
      path: '/api/resellers/:id',
      tag: 'org',
      summary: 'One reseller',
      auth: { perm: 'org:read' },
      params: IdParams,
      responses: { 200: Reseller },
      errors: [404],
      handler: ({ params, user, deps }) => resellerCrud.read(deps, user, params.id),
    }),
    defineRoute({
      method: 'POST',
      path: '/api/resellers',
      tag: 'org',
      summary: 'Add a reseller',
      auth: { perm: 'org:write' },
      body: ResellerInput,
      responses: { 201: Reseller },
      errors: [409],
      handler: async ({ body, user, req, deps }) => {
        writer(user);
        return deps.db.tx(async (tx) => {
          const r = await deps.db.one<{ id: string }>('INSERT INTO resellers (name, document, email, phone) VALUES ($1, $2, $3, $4) RETURNING id', [body.name, body.document ?? null, body.email ?? null, body.phone ?? null], tx);
          const view = await resellerCrud.read(deps, user, r!.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'reseller.create', entityType: 'reseller', entityId: r!.id, after: view });
          return view;
        });
      },
    }),
    defineRoute({
      method: 'PATCH',
      path: '/api/resellers/:id',
      tag: 'org',
      summary: 'Change a reseller',
      auth: { perm: 'org:write' },
      params: IdParams,
      body: ResellerInput.partial(),
      responses: { 200: Reseller },
      errors: [404, 409],
      handler: async ({ params, body, user, req, deps }) => {
        writer(user);
        return deps.db.tx(async (tx) => {
          const before = await resellerCrud.read(deps, user, params.id, tx);
          await deps.db.query(
            `UPDATE resellers SET name = coalesce($2, name),
                    document = CASE WHEN $6 THEN $3 ELSE document END, email = CASE WHEN $7 THEN $4 ELSE email END, phone = CASE WHEN $8 THEN $5 ELSE phone END,
                    updated_at = now() WHERE id = $1`,
            [params.id, body.name ?? null, body.document ?? null, body.email ?? null, body.phone ?? null, 'document' in body, 'email' in body, 'phone' in body],
            tx,
          );
          const after = await resellerCrud.read(deps, user, params.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'reseller.update', entityType: 'reseller', entityId: params.id, before, after });
          return after;
        });
      },
    }),
    defineRoute({
      method: 'DELETE',
      path: '/api/resellers/:id',
      tag: 'org',
      summary: 'Remove a reseller without customers',
      auth: { perm: 'org:write' },
      params: IdParams,
      responses: { 200: Ok },
      errors: [404, 409],
      handler: async ({ params, user, req, deps }) => {
        writer(user);
        await deps.db.tx(async (tx) => {
          const before = await resellerCrud.read(deps, user, params.id, tx);
          await deps.db.query('DELETE FROM resellers WHERE id = $1', [params.id], tx);
          await audit(deps.db, tx, actorOf(req), { action: 'reseller.delete', entityType: 'reseller', entityId: params.id, before });
        });
        return { ok: true as const };
      },
    }),

    // customers
    defineRoute({
      method: 'GET',
      path: '/api/customers',
      tag: 'org',
      summary: 'Customers in your scope',
      auth: { perm: 'org:read' },
      query: CustomerQuery,
      responses: { 200: z.array(Customer) },
      handler: ({ query, user, deps }) => customers(deps, user, query),
    }),
    defineRoute({
      method: 'GET',
      path: '/api/customers/:id',
      tag: 'org',
      summary: 'One customer',
      auth: { perm: 'org:read' },
      params: IdParams,
      responses: { 200: Customer },
      errors: [404],
      handler: ({ params, user, deps }) => customerCrud.read(deps, user, params.id),
    }),
    defineRoute({
      method: 'POST',
      path: '/api/customers',
      tag: 'org',
      summary: 'Add a customer (condomínio, eletroposto, empresa)',
      auth: { perm: 'org:write' },
      body: CustomerInput,
      responses: { 201: Customer },
      errors: [409],
      handler: async ({ body, user, req, deps }) => {
        writer(user);
        return deps.db.tx(async (tx) => {
          const c = await deps.db.one<{ id: string }>(
            `INSERT INTO customers (reseller_id, legal_name, trade_name, document_type, document, address, contacts, billing_contact, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
              body.resellerId ?? null,
              body.legalName,
              body.tradeName ?? null,
              documentTypeOf(body.document),
              body.document,
              JSON.stringify(body.address ?? {}),
              JSON.stringify(body.contacts ?? []),
              body.billingContact ? JSON.stringify(body.billingContact) : null,
              body.notes ?? null,
            ],
            tx,
          );
          const view = await customerCrud.read(deps, user, c!.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'customer.create', entityType: 'customer', entityId: c!.id, after: view });
          return view;
        });
      },
    }),
    defineRoute({
      method: 'PATCH',
      path: '/api/customers/:id',
      tag: 'org',
      summary: 'Change a customer',
      auth: { perm: 'org:write' },
      params: IdParams,
      body: CustomerInput.partial(),
      responses: { 200: Customer },
      errors: [404, 409],
      handler: async ({ params, body, user, req, deps }) => {
        writer(user);
        return deps.db.tx(async (tx) => {
          const before = await customerCrud.read(deps, user, params.id, tx);
          const set: string[] = [];
          const values: unknown[] = [params.id];
          const put = (col: string, v: unknown) => set.push(`${col} = $${values.push(v)}`);
          if ('resellerId' in body) put('reseller_id', body.resellerId ?? null);
          if (body.legalName !== undefined) put('legal_name', body.legalName);
          if ('tradeName' in body) put('trade_name', body.tradeName ?? null);
          if (body.document !== undefined) {
            put('document', body.document);
            put('document_type', documentTypeOf(body.document));
          }
          if (body.address !== undefined) put('address', JSON.stringify(body.address));
          if (body.contacts !== undefined) put('contacts', JSON.stringify(body.contacts));
          if ('billingContact' in body) put('billing_contact', body.billingContact ? JSON.stringify(body.billingContact) : null);
          if ('notes' in body) put('notes', body.notes ?? null);
          if (set.length) await deps.db.query(`UPDATE customers SET ${set.join(', ')}, updated_at = now() WHERE id = $1`, values, tx);
          const after = await customerCrud.read(deps, user, params.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'customer.update', entityType: 'customer', entityId: params.id, before, after });
          return after;
        });
      },
    }),
    defineRoute({
      method: 'DELETE',
      path: '/api/customers/:id',
      tag: 'org',
      summary: 'Remove a customer without sites',
      auth: { perm: 'org:write' },
      params: IdParams,
      responses: { 200: Ok },
      errors: [404, 409],
      handler: async ({ params, user, req, deps }) => {
        writer(user);
        await deps.db.tx(async (tx) => {
          const before = await customerCrud.read(deps, user, params.id, tx);
          await deps.db.query('DELETE FROM customers WHERE id = $1', [params.id], tx);
          await audit(deps.db, tx, actorOf(req), { action: 'customer.delete', entityType: 'customer', entityId: params.id, before });
        });
        return { ok: true as const };
      },
    }),

    // sites
    defineRoute({
      method: 'GET',
      path: '/api/sites',
      tag: 'org',
      summary: 'Sites in your scope',
      auth: { perm: 'org:read' },
      query: SiteQuery,
      responses: { 200: z.array(Site) },
      handler: ({ query, user, deps }) => sites(deps, user, query),
    }),
    defineRoute({
      method: 'GET',
      path: '/api/sites/:id',
      tag: 'org',
      summary: 'One site',
      auth: { perm: 'org:read' },
      params: IdParams,
      responses: { 200: Site },
      errors: [404],
      handler: ({ params, user, deps }) => siteCrud.read(deps, user, params.id),
    }),
    defineRoute({
      method: 'POST',
      path: '/api/sites',
      tag: 'org',
      summary: 'Add a site to a customer',
      auth: { perm: 'org:write' },
      body: SiteInput,
      responses: { 201: Site },
      errors: [404],
      handler: async ({ body, user, req, deps }) => {
        writer(user);
        return deps.db.tx(async (tx) => {
          await customerCrud.read(deps, user, body.customerId, tx);
          const s = await deps.db.one<{ id: string }>(
            'INSERT INTO sites (customer_id, name, kind, address, utility, timezone) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [body.customerId, body.name, body.kind, JSON.stringify(body.address ?? {}), body.utility ?? null, body.timezone],
            tx,
          );
          const view = await siteCrud.read(deps, user, s!.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'site.create', entityType: 'site', entityId: s!.id, after: view });
          return view;
        });
      },
    }),
    defineRoute({
      method: 'PATCH',
      path: '/api/sites/:id',
      tag: 'org',
      summary: 'Change a site (or move it to another customer)',
      auth: { perm: 'org:write' },
      params: IdParams,
      body: SiteInput.partial(),
      responses: { 200: Site },
      errors: [404],
      handler: async ({ params, body, user, req, deps }) => {
        writer(user);
        return deps.db.tx(async (tx) => {
          const before = await siteCrud.read(deps, user, params.id, tx);
          if (body.customerId) await customerCrud.read(deps, user, body.customerId, tx);
          const set: string[] = [];
          const values: unknown[] = [params.id];
          const put = (col: string, v: unknown) => set.push(`${col} = $${values.push(v)}`);
          if (body.customerId) put('customer_id', body.customerId);
          if (body.name !== undefined) put('name', body.name);
          if (body.kind !== undefined) put('kind', body.kind);
          if (body.address !== undefined) put('address', JSON.stringify(body.address));
          if ('utility' in body) put('utility', body.utility ?? null);
          // A partial body still has the timezone's default: only an explicit one changes it.
          if (body.timezone !== undefined && (req.body as Record<string, unknown>)['timezone'] !== undefined) put('timezone', body.timezone);
          if (set.length) await deps.db.query(`UPDATE sites SET ${set.join(', ')}, updated_at = now() WHERE id = $1`, values, tx);
          const after = await siteCrud.read(deps, user, params.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'site.update', entityType: 'site', entityId: params.id, before, after });
          return after;
        });
      },
    }),
    defineRoute({
      method: 'DELETE',
      path: '/api/sites/:id',
      tag: 'org',
      summary: 'Remove a site without devices',
      auth: { perm: 'org:write' },
      params: IdParams,
      responses: { 200: Ok },
      errors: [404, 409],
      handler: async ({ params, user, req, deps }) => {
        writer(user);
        await deps.db.tx(async (tx) => {
          const before = await siteCrud.read(deps, user, params.id, tx);
          await deps.db.query('DELETE FROM sites WHERE id = $1', [params.id], tx);
          await audit(deps.db, tx, actorOf(req), { action: 'site.delete', entityType: 'site', entityId: params.id, before });
        });
        return { ok: true as const };
      },
    }),
  ];
}

/** A site the person may act on with a permission, or 404/403. */
export async function siteInScope(deps: Deps, user: SessionUser, siteId: string, perm: Permission, on?: Queryable): Promise<SiteView> {
  const site = one(await sites(deps, user, { id: siteId }, on), 'site');
  const scope = scopeOf(user, perm);
  if (!scope) throw forbidden(`needs the permission ${perm}`);
  if (scope.all) return site;
  const ok = scope.siteIds.includes(site.id) || scope.customerIds.includes(site.customer.id) || (site.reseller !== null && scope.resellerIds.includes(site.reseller.id));
  if (!ok) throw forbidden(`needs the permission ${perm} on this site`);
  return site;
}
