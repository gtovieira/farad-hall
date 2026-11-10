// Signing in and out, the signed-in person, their password.
import { z } from 'zod';
import { actorOf, audit } from '../audit.js';
import { Lockout } from '../auth/lockout.js';
import { dummyHash, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../auth/passwords.js';
import { permissionsOf } from '../auth/rbac.js';
import { createSession, endSession, loadRoles } from '../auth/sessions.js';
import type { Deps } from '../context.js';
import { clientIp } from '../device/auth.js';
import { HttpError } from '../http/errors.js';
import { defineRoute, type AnyRoute } from '../http/route.js';
import { IsoTime, Locale, Me, Ok, User } from '../schemas.js';

/** Five failed logins from one address (or for one e-mail from one address) in 15 minutes lock it out for the rest of the window. */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;

export interface UserRow {
  id: string;
  email: string;
  name: string;
  locale: 'pt-BR' | 'en';
  disabled_at: Date | null;
  created_at: Date;
}

export async function userView(deps: Deps, row: UserRow): Promise<z.infer<typeof User>> {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    disabled: row.disabled_at !== null,
    roles: await loadRoles(deps.db, row.id),
    createdAt: row.created_at.toISOString(),
  };
}

const LoginBody = z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(500) });
const LoginAnswer = z.object({ user: User, expiresAt: IsoTime });
const PasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(500) });
const MePatch = z.object({ name: z.string().trim().min(1).max(200).optional(), locale: Locale.optional() });

export function authRoutes(): AnyRoute[] {
  const lockout = new Lockout(MAX_FAILURES, WINDOW_MS);
  return [
    defineRoute({
      method: 'POST',
      path: '/api/auth/login',
      tag: 'auth',
      summary: 'Sign in with e-mail and password: sets the session cookie (hall_session)',
      auth: 'public',
      body: LoginBody,
      responses: { 200: LoginAnswer },
      errors: [429],
      handler: async ({ body, req, reply, deps }) => {
        const ip = clientIp(req);
        const now = deps.now().getTime();
        const keys = [`ip:${ip}`, `ip:${ip}:${body.email.toLowerCase()}`];
        const wait = Math.max(...keys.map((k) => lockout.retryAfterS(k, now)));
        if (wait) {
          void reply.header('retry-after', String(wait));
          throw new HttpError(429, 'locked-out', 'too many failed sign-ins: try again later', { retryAfterS: wait });
        }
        const row = await deps.db.one<UserRow & { password_hash: string }>('SELECT * FROM users WHERE lower(email) = lower($1)', [body.email]);
        const ok = await verifyPassword(body.password, row?.password_hash ?? (await dummyHash()));
        if (!row || !ok || row.disabled_at) {
          const left = Math.min(...keys.map((k) => lockout.fail(k, now)));
          await audit(deps.db, deps.db.pool, { ...actorOf(req), label: body.email.slice(0, 200) }, { action: 'auth.login-failed', entityType: 'user', entityId: row?.id ?? null });
          throw new HttpError(401, 'invalid-credentials', 'wrong e-mail or password', { remainingAttempts: left });
        }
        keys.forEach((k) => lockout.clear(k));
        const expiresAt = await createSession(deps, row.id, req, reply);
        await audit(deps.db, deps.db.pool, { ...actorOf(req), type: 'user', id: row.id, label: row.email }, { action: 'auth.login', entityType: 'user', entityId: row.id });
        return { user: await userView(deps, row), expiresAt: expiresAt.toISOString() };
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/api/auth/logout',
      tag: 'auth',
      summary: 'Sign out: ends this session',
      auth: 'session',
      responses: { 200: Ok },
      handler: async ({ req, reply, deps }) => {
        await endSession(deps, req, reply);
        await audit(deps.db, deps.db.pool, actorOf(req), { action: 'auth.logout', entityType: 'user', entityId: req.user!.id });
        return { ok: true as const };
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/api/auth/me',
      tag: 'auth',
      summary: 'The signed-in person, their roles and permissions',
      auth: 'session',
      responses: { 200: Me },
      handler: async ({ user, deps }) => {
        const row = await deps.db.one<UserRow>('SELECT * FROM users WHERE id = $1', [user.id]);
        return { user: await userView(deps, row!), permissions: permissionsOf(user) };
      },
    }),
    defineRoute({
      method: 'PATCH',
      path: '/api/auth/me',
      tag: 'auth',
      summary: 'Change your name or language',
      auth: 'session',
      body: MePatch,
      responses: { 200: Me },
      handler: async ({ body, user, req, deps }) => {
        const row = await deps.db.tx(async (tx) => {
          const before = await deps.db.one<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user.id], tx);
          const after = await deps.db.one<UserRow>(
            'UPDATE users SET name = coalesce($2, name), locale = coalesce($3, locale), updated_at = now() WHERE id = $1 RETURNING *',
            [user.id, body.name ?? null, body.locale ?? null],
            tx,
          );
          await audit(deps.db, tx, actorOf(req), { action: 'user.update', entityType: 'user', entityId: user.id, before: { name: before!.name, locale: before!.locale }, after: body });
          return after!;
        });
        return { user: await userView(deps, row), permissions: permissionsOf(user) };
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/api/auth/password',
      tag: 'auth',
      summary: 'Change your password: ends your other sessions',
      auth: 'session',
      body: PasswordBody,
      responses: { 200: Ok },
      errors: [403],
      handler: async ({ body, user, req, deps }) => {
        const row = await deps.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
        if (!(await verifyPassword(body.currentPassword, row!.password_hash))) throw new HttpError(403, 'invalid-credentials', 'the current password is wrong');
        const hash = await hashPassword(body.newPassword);
        await deps.db.tx(async (tx) => {
          await deps.db.query('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [user.id, hash], tx);
          await deps.db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, req.sessionTokenHash], tx);
          await audit(deps.db, tx, actorOf(req), { action: 'user.password-change', entityType: 'user', entityId: user.id });
        });
        return { ok: true as const };
      },
    }),
  ];
}
