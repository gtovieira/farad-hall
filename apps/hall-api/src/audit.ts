// The audit log: who changed what, when, from where. Written in the same transaction as the change.
import type { FastifyRequest } from 'fastify';
import type { Db, Queryable } from './db.js';

export interface Actor {
  type: 'user' | 'device' | 'system';
  id: string | null;
  label: string | null;
  ip: string | null;
  userAgent: string | null;
}

export const SYSTEM: Actor = { type: 'system', id: null, label: 'hall', ip: null, userAgent: null };

/** The person (or device) behind a request. */
export function actorOf(req: FastifyRequest): Actor {
  const ua = req.headers['user-agent'];
  if (req.user) return { type: 'user', id: req.user.id, label: req.user.email, ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null };
  if (req.device) return { type: 'device', id: req.device.id, label: req.device.name, ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null };
  return { ...SYSTEM, ip: req.ip };
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
}

/** Fields never written to the log. */
const SECRET = new Set(['password', 'passwordHash', 'password_hash', 'newPassword', 'currentPassword', 'code', 'token']);

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.has(k) ? '[redacted]' : redact(x)]));
  }
  return v;
}

export async function audit(db: Db, on: Queryable, actor: Actor, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_type, actor_id, actor_label, action, entity_type, entity_id, before, after, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor.type,
      actor.id,
      actor.label,
      e.action,
      e.entityType,
      e.entityId,
      e.before === undefined ? null : JSON.stringify(redact(e.before)),
      e.after === undefined ? null : JSON.stringify(redact(e.after)),
      actor.ip,
      actor.userAgent,
    ],
    on,
  );
}
