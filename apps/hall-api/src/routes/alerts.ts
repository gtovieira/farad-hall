// Alerts: list, acknowledge (someone is on it), close (with a note). Opened and auto-closed by the
// engine (src/alerts/engine.ts).
import { z } from 'zod';
import { actorOf, audit } from '../audit.js';
import { scopeOf, siteScopeSql } from '../auth/rbac.js';
import type { Deps, SessionUser } from '../context.js';
import type { Queryable } from '../db.js';
import { conflict, notFound } from '../http/errors.js';
import { defineRoute, type AnyRoute } from '../http/route.js';
import { Alert, AlertRule, AlertStatus, IdParams, limitQuery, Uuid } from '../schemas.js';
import { siteInScope } from './org.js';

type AlertView = z.infer<typeof Alert>;

interface Row {
  id: string;
  rule: AlertView['rule'];
  severity: AlertView['severity'];
  status: AlertView['status'];
  title: string;
  details: Record<string, unknown>;
  occurrences: number;
  opened_at: Date;
  last_occurred_at: Date;
  acknowledged_at: Date | null;
  ack_by: string | null;
  ack_note: string | null;
  closed_at: Date | null;
  closed_by_email: string | null;
  close_reason: 'auto' | 'manual' | null;
  close_note: string | null;
  notified_at: Date | null;
  device_id: string;
  device_name: string;
  site_id: string;
  site_name: string;
  customer_id: string;
  customer_name: string;
}

const view = (r: Row): AlertView => ({
  id: r.id,
  rule: r.rule,
  severity: r.severity,
  status: r.status,
  title: r.title,
  details: r.details,
  occurrences: r.occurrences,
  openedAt: r.opened_at.toISOString(),
  lastOccurredAt: r.last_occurred_at.toISOString(),
  acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
  acknowledgedBy: r.ack_by,
  ackNote: r.ack_note,
  closedAt: r.closed_at?.toISOString() ?? null,
  closedBy: r.closed_by_email,
  closeReason: r.close_reason,
  closeNote: r.close_note,
  notifiedAt: r.notified_at?.toISOString() ?? null,
  device: { id: r.device_id, name: r.device_name },
  site: { id: r.site_id, name: r.site_name },
  customer: { id: r.customer_id, name: r.customer_name },
});

export interface AlertFilter {
  id?: string;
  deviceId?: string;
  siteId?: string;
  status?: z.infer<typeof AlertStatus>;
  rule?: z.infer<typeof AlertRule>;
  /** Open or acknowledged. */
  active?: boolean;
  limit?: number;
}

export async function alertsOf(deps: Deps, user: SessionUser, f: AlertFilter, on?: Queryable): Promise<AlertView[]> {
  const params: unknown[] = [];
  const where = [siteScopeSql(scopeOf(user, 'alerts:read') ?? { all: false, resellerIds: [], customerIds: [], siteIds: [] }, params)];
  if (f.id) where.push(`a.id = $${params.push(f.id)}`);
  if (f.deviceId) where.push(`a.device_id = $${params.push(f.deviceId)}`);
  if (f.siteId) where.push(`a.site_id = $${params.push(f.siteId)}`);
  if (f.status) where.push(`a.status = $${params.push(f.status)}`);
  if (f.rule) where.push(`a.rule = $${params.push(f.rule)}`);
  if (f.active) where.push(`a.status <> 'closed'`);
  const rows = await deps.db.query<Row>(
    `SELECT a.*, ua.email AS ack_by, uc.email AS closed_by_email, d.name AS device_name, s.name AS site_name,
            c.id AS customer_id, c.legal_name AS customer_name
       FROM alerts a
       JOIN devices d ON d.id = a.device_id
       JOIN sites s ON s.id = a.site_id
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users ua ON ua.id = a.acknowledged_by
       LEFT JOIN users uc ON uc.id = a.closed_by
      WHERE ${where.join(' AND ')}
      ORDER BY (a.status = 'closed'), a.severity = 'warning', a.opened_at DESC
      LIMIT $${params.push(f.limit ?? 500)}`,
    params,
    on,
  );
  return rows.map(view);
}

const ListQuery = z.object({
  status: AlertStatus.optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true')
    .describe('true: open and acknowledged only'),
  rule: AlertRule.optional(),
  deviceId: Uuid.optional(),
  siteId: Uuid.optional(),
  limit: limitQuery(200, 1000),
});
const NoteBody = z.object({ note: z.string().trim().max(2000).optional() });

async function oneAlert(deps: Deps, user: SessionUser, id: string, on: Queryable): Promise<AlertView> {
  const a = (await alertsOf(deps, user, { id }, on))[0];
  if (!a) throw notFound('alert');
  // Acting on it needs alerts:manage on its site.
  await siteInScope(deps, user, a.site.id, 'alerts:manage', on);
  return a;
}

export function alertRoutes(): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/api/alerts',
      tag: 'alerts',
      summary: 'Alerts in your scope: active first, then the newest',
      auth: { perm: 'alerts:read' },
      query: ListQuery,
      responses: { 200: z.array(Alert) },
      handler: ({ query, user, deps }) => alertsOf(deps, user, query),
    }),
    defineRoute({
      method: 'POST',
      path: '/api/alerts/:id/acknowledge',
      tag: 'alerts',
      summary: 'Acknowledge an open alert: someone is on it',
      auth: { perm: 'alerts:manage' },
      params: IdParams,
      body: NoteBody,
      responses: { 200: Alert },
      errors: [404, 409],
      handler: async ({ params, body, user, req, deps }) =>
        deps.db.tx(async (tx) => {
          const before = await oneAlert(deps, user, params.id, tx);
          if (before.status !== 'open') throw conflict(`the alert is ${before.status}`);
          await deps.db.query("UPDATE alerts SET status = 'acknowledged', acknowledged_at = $2, acknowledged_by = $3, ack_note = $4 WHERE id = $1", [params.id, deps.now(), user.id, body.note || null], tx);
          const after = await oneAlert(deps, user, params.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'alert.acknowledge', entityType: 'alert', entityId: params.id, before: { status: before.status }, after: { status: after.status, note: body.note ?? null } });
          return after;
        }),
    }),
    defineRoute({
      method: 'POST',
      path: '/api/alerts/:id/close',
      tag: 'alerts',
      summary: 'Close an alert, with a note on what was done',
      auth: { perm: 'alerts:manage' },
      params: IdParams,
      body: NoteBody,
      responses: { 200: Alert },
      errors: [404, 409],
      handler: async ({ params, body, user, req, deps }) =>
        deps.db.tx(async (tx) => {
          const before = await oneAlert(deps, user, params.id, tx);
          if (before.status === 'closed') throw conflict('the alert is closed already');
          await deps.db.query("UPDATE alerts SET status = 'closed', closed_at = $2, closed_by = $3, close_reason = 'manual', close_note = $4 WHERE id = $1", [params.id, deps.now(), user.id, body.note || null], tx);
          const after = await oneAlert(deps, user, params.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'alert.close', entityType: 'alert', entityId: params.id, before: { status: before.status }, after: { status: 'closed', note: body.note ?? null } });
          return after;
        }),
    }),
  ];
}
