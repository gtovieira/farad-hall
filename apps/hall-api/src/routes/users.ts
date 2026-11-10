// People and their roles (admin-farad). Phase 1 has no screen for this: the API and the CLI.
import { z } from 'zod';
import { actorOf, audit } from '../audit.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords.js';
import { loadRoles } from '../auth/sessions.js';
import type { Deps } from '../context.js';
import type { Queryable } from '../db.js';
import { HttpError, notFound } from '../http/errors.js';
import { defineRoute, type AnyRoute } from '../http/route.js';
import { IdParams, Locale, RoleAssignmentInput, User } from '../schemas.js';
import { userView, type UserRow } from './auth.js';

const UserCreate = z.object({
  email: z.email().max(200),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(500),
  locale: Locale.default('pt-BR'),
  roles: z.array(RoleAssignmentInput).min(1).max(50),
});
const UserPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  locale: Locale.optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(500).optional().describe('A new password: ends every session of the person'),
  roles: z.array(RoleAssignmentInput).min(1).max(50).optional().describe('Replaces every role'),
});

type RoleInput = z.infer<typeof RoleAssignmentInput>;

/** Replaces a person's roles; refuses a role at a scope it cannot have (the table's checks). */
export async function setRoles(deps: Deps, on: Queryable, userId: string, roles: RoleInput[]): Promise<void> {
  await deps.db.query('DELETE FROM role_assignments WHERE user_id = $1', [userId], on);
  for (const r of roles) {
    await deps.db.query('INSERT INTO role_assignments (user_id, role, reseller_id, customer_id, site_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [
      userId,
      r.role,
      r.resellerId ?? null,
      r.customerId ?? null,
      r.siteId ?? null,
    ], on);
  }
}

export function userRoutes(): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/api/users',
      tag: 'users',
      summary: 'Every person',
      auth: { perm: 'users:manage' },
      responses: { 200: z.array(User) },
      handler: async ({ deps }) => {
        const rows = await deps.db.query<UserRow>('SELECT * FROM users ORDER BY lower(name)');
        return Promise.all(rows.map((r) => userView(deps, r)));
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/api/users',
      tag: 'users',
      summary: 'Add a person with their roles',
      auth: { perm: 'users:manage' },
      body: UserCreate,
      responses: { 201: User },
      errors: [409],
      handler: async ({ body, req, deps }) => {
        const hash = await hashPassword(body.password);
        const row = await deps.db.tx(async (tx) => {
          const u = await deps.db.one<UserRow>('INSERT INTO users (email, name, password_hash, locale) VALUES ($1, $2, $3, $4) RETURNING *', [body.email, body.name, hash, body.locale], tx);
          await setRoles(deps, tx, u!.id, body.roles);
          await audit(deps.db, tx, actorOf(req), { action: 'user.create', entityType: 'user', entityId: u!.id, after: { email: body.email, name: body.name, roles: body.roles } });
          return u!;
        });
        return userView(deps, row);
      },
    }),
    defineRoute({
      method: 'PATCH',
      path: '/api/users/:id',
      tag: 'users',
      summary: 'Change a person: name, language, roles, password, disabled',
      auth: { perm: 'users:manage' },
      params: IdParams,
      body: UserPatch,
      responses: { 200: User },
      errors: [404, 409],
      handler: async ({ params, body, req, user, deps }) => {
        if (params.id === user.id && (body.disabled || (body.roles && !body.roles.some((r) => r.role === 'admin-farad')))) {
          throw new HttpError(409, 'conflict', 'you cannot disable yourself or drop your own admin-farad role');
        }
        const hash = body.password ? await hashPassword(body.password) : null;
        const row = await deps.db.tx(async (tx) => {
          const before = await deps.db.one<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [params.id], tx);
          if (!before) throw notFound('user');
          const rolesBefore = await loadRoles(deps.db, params.id, tx);
          const after = await deps.db.one<UserRow>(
            `UPDATE users SET name = coalesce($2, name), locale = coalesce($3, locale),
                    disabled_at = CASE WHEN $4::boolean IS NULL THEN disabled_at WHEN $4 THEN coalesce(disabled_at, now()) ELSE NULL END,
                    password_hash = coalesce($5, password_hash), password_changed_at = CASE WHEN $5::text IS NULL THEN password_changed_at ELSE now() END,
                    updated_at = now()
              WHERE id = $1 RETURNING *`,
            [params.id, body.name ?? null, body.locale ?? null, body.disabled ?? null, hash],
            tx,
          );
          if (body.roles) await setRoles(deps, tx, params.id, body.roles);
          if (hash || body.disabled) await deps.db.query('DELETE FROM sessions WHERE user_id = $1', [params.id], tx);
          await audit(deps.db, tx, actorOf(req), {
            action: 'user.update',
            entityType: 'user',
            entityId: params.id,
            before: { name: before.name, locale: before.locale, disabled: before.disabled_at !== null, roles: rolesBefore },
            after: { ...body, ...(hash ? { password: 'changed' } : {}) },
          });
          return after!;
        });
        return userView(deps, row);
      },
    }),
  ];
}
