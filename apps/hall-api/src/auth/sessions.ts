// Sessions of people: a random token in an httpOnly, SameSite=Strict cookie; Postgres keeps only
// its SHA-256. A session ends at its expiry, on logout, when the person is disabled, or when the
// password changes (every session of that person).
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Deps, RoleAssignment, SessionUser } from '../context.js';
import type { Db, Queryable } from '../db.js';
import { HttpError } from '../http/errors.js';
import type { Role } from './rbac.js';

export const SESSION_COOKIE = 'hall_session';

const hashToken = (token: string) => createHash('sha256').update(token).digest();

export async function createSession(deps: Deps, userId: string, req: FastifyRequest, reply: FastifyReply): Promise<Date> {
  const token = randomBytes(32).toString('base64url');
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + deps.config.sessionTtlH * 3600_000);
  const ua = req.headers['user-agent'];
  await deps.db.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES ($1, $2, $3, $4, $3, $5, $6)', [
    hashToken(token),
    userId,
    now,
    expiresAt,
    req.ip,
    typeof ua === 'string' ? ua.slice(0, 300) : null,
  ]);
  void reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: deps.config.cookieSecure,
    expires: expiresAt,
  });
  return expiresAt;
}

export async function endSession(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.sessionTokenHash) await deps.db.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionTokenHash]);
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function loadRoles(db: Db, userId: string, on?: Queryable): Promise<RoleAssignment[]> {
  const rows = await db.query<{ role: Role; reseller_id: string | null; customer_id: string | null; site_id: string | null }>(
    'SELECT role, reseller_id, customer_id, site_id FROM role_assignments WHERE user_id = $1 ORDER BY created_at, role',
    [userId],
    on,
  );
  return rows.map((r) => ({ role: r.role, resellerId: r.reseller_id, customerId: r.customer_id, siteId: r.site_id }));
}

/** A signed-in person's request: its session, from the cookie. 401 otherwise. */
export function sessionAuthenticator(deps: Deps) {
  return async (req: FastifyRequest): Promise<SessionUser> => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError(401, 'unauthorized', 'sign in', { hint: 'POST /api/auth/login' });
    // A cross-site request: refused even with a cookie (SameSite=Strict already keeps it out).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let host: string | undefined;
        try {
          host = new URL(origin).host;
        } catch {
          host = undefined;
        }
        if (host !== req.headers.host) throw new HttpError(403, 'forbidden', 'cross-origin request refused');
      }
    }
    const tokenHash = hashToken(token);
    const now = deps.now();
    const row = await deps.db.one<{ id: string; email: string; name: string; locale: 'pt-BR' | 'en'; last_seen_at: Date }>(
      `SELECT u.id, u.email, u.name, u.locale, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.disabled_at IS NULL`,
      [tokenHash, now],
    );
    if (!row) throw new HttpError(401, 'unauthorized', 'the session ended: sign in again');
    // last_seen_at at most once a minute: no write per request.
    if (now.getTime() - row.last_seen_at.getTime() > 60_000) {
      await deps.db.query('UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1', [tokenHash, now]);
    }
    req.sessionTokenHash = tokenHash;
    return { id: row.id, email: row.email, name: row.name, locale: row.locale, roles: await loadRoles(deps.db, row.id) };
  };
}
