// Roles and scopes. A person holds roles, each at a scope: Farad (everything), a reseller, a
// customer or a site. A permission is granted by the roles that include it, over the union of
// their scopes. Only admin-farad has screens in phase 1; the model and the checks are complete.
import { z } from 'zod';
import type { RoleAssignment, SessionUser } from '../context.js';
import { forbidden } from '../http/errors.js';

export const Role = z.enum(['admin-farad', 'financeiro', 'suporte', 'revenda', 'cliente']);
export type Role = z.infer<typeof Role>;

export const Permission = z.enum([
  'fleet:read', // devices, their telemetry and events
  'devices:manage', // claim codes, rename, transfer, revoke
  'org:read', // resellers, customers, sites
  'org:write',
  'alerts:read',
  'alerts:manage', // acknowledge, close
  'users:manage',
  'audit:read',
  'settings:manage',
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  'admin-farad': Permission.options,
  financeiro: ['org:read', 'fleet:read', 'alerts:read'],
  suporte: ['fleet:read', 'devices:manage', 'org:read', 'alerts:read', 'alerts:manage'],
  revenda: ['fleet:read', 'devices:manage', 'org:read', 'alerts:read', 'alerts:manage'],
  cliente: ['fleet:read', 'org:read', 'alerts:read'],
};

/** Everything, or the union of some resellers, customers and sites. */
export type Scope = { all: true } | { all: false; resellerIds: string[]; customerIds: string[]; siteIds: string[] };

const isGlobal = (a: RoleAssignment) => !a.resellerId && !a.customerId && !a.siteId;

/** Where a person holds a permission; null when nowhere. */
export function scopeOf(user: SessionUser, perm: Permission): Scope | null {
  const grants = user.roles.filter((a) => ROLE_PERMISSIONS[a.role].includes(perm));
  if (grants.length === 0) return null;
  if (grants.some(isGlobal)) return { all: true };
  return {
    all: false,
    resellerIds: grants.flatMap((g) => (g.resellerId ? [g.resellerId] : [])),
    customerIds: grants.flatMap((g) => (g.customerId ? [g.customerId] : [])),
    siteIds: grants.flatMap((g) => (g.siteId ? [g.siteId] : [])),
  };
}

export function permissionsOf(user: SessionUser): Permission[] {
  return Permission.options.filter((p) => scopeOf(user, p) !== null);
}

/** Throws 403 unless the person holds the permission somewhere. */
export function permit(user: SessionUser, perm: Permission): void {
  if (!scopeOf(user, perm)) throw forbidden(`needs the permission ${perm}`);
}

/** Throws 403 unless the person holds the permission everywhere (Farad scope). */
export function permitGlobal(user: SessionUser, perm: Permission): void {
  const s = scopeOf(user, perm);
  if (!s?.all) throw forbidden(`needs the permission ${perm} at the Farad scope`);
}

/**
 * The SQL condition "this site is in the scope", given the aliases of the sites and customers
 * tables in the query. Pushes its parameters onto `params`.
 */
export function siteScopeSql(scope: Scope, params: unknown[], site = 's', customer = 'c'): string {
  if (scope.all) return 'TRUE';
  params.push(scope.siteIds, scope.customerIds, scope.resellerIds);
  const n = params.length;
  return `(${site}.id = ANY($${n - 2}::uuid[]) OR ${site}.customer_id = ANY($${n - 1}::uuid[]) OR ${customer}.reseller_id = ANY($${n}::uuid[]))`;
}

/** The SQL condition "this customer is in the scope" (a site scope reaches its customer, read only). */
export function customerScopeSql(scope: Scope, params: unknown[], customer = 'c'): string {
  if (scope.all) return 'TRUE';
  params.push(scope.customerIds, scope.resellerIds, scope.siteIds);
  const n = params.length;
  return `(${customer}.id = ANY($${n - 2}::uuid[]) OR ${customer}.reseller_id = ANY($${n - 1}::uuid[]) OR ${customer}.id IN (SELECT customer_id FROM sites WHERE id = ANY($${n}::uuid[])))`;
}
