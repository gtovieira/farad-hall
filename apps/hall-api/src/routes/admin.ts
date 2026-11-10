// Hall itself: health, the contract, the audit log, the alert settings.
import { CURRENT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@hall/protocol';
import { z } from 'zod';
import { actorOf, audit } from '../audit.js';
import { defineRoute, type AnyRoute } from '../http/route.js';
import { AuditEntry, IsoTime, limitQuery } from '../schemas.js';
import { AlertSettings, getAlertSettings, putAlertSettings } from '../settings.js';

const Health = z.object({
  ok: z.boolean(),
  version: z.string(),
  protocol: z.object({ current: z.number().int(), supported: z.array(z.number().int()) }),
  db: z.object({ ok: z.boolean() }),
  time: IsoTime,
});

const AuditQuery = z.object({
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  actorId: z.string().max(100).optional(),
  beforeId: z.coerce.number().int().optional().describe('Entries older than this id (paging)'),
  limit: limitQuery(100, 1000),
});

export function adminRoutes(openapi: () => Record<string, unknown>): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/api/health',
      tag: 'meta',
      summary: 'Is Hall up: 200 when it and its database answer, 503 otherwise',
      auth: 'public',
      responses: { 200: Health, 503: { description: 'The database does not answer', schema: Health } },
      handler: async ({ reply, deps }) => {
        let db = false;
        try {
          db = (await deps.db.one<{ ok: number }>('SELECT 1 AS ok'))?.ok === 1;
        } catch {
          db = false;
        }
        if (!db) void reply.code(503);
        return {
          ok: db,
          version: deps.config.version,
          protocol: { current: CURRENT_PROTOCOL_VERSION, supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
          db: { ok: db },
          time: deps.now().toISOString(),
        };
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/api/openapi.json',
      tag: 'meta',
      summary: 'This contract (OpenAPI 3.1)',
      auth: 'public',
      responses: { 200: { description: 'The OpenAPI document', content: { type: 'application/json', description: 'docs/api/openapi.json' } } },
      handler: async () => openapi(),
    }),
    defineRoute({
      method: 'GET',
      path: '/api/audit',
      tag: 'audit',
      summary: 'The audit log, newest first',
      auth: { perm: 'audit:read' },
      query: AuditQuery,
      responses: { 200: z.array(AuditEntry) },
      handler: async ({ query, deps }) => {
        const params: unknown[] = [];
        const where: string[] = ['TRUE'];
        if (query.entityType) where.push(`entity_type = $${params.push(query.entityType)}`);
        if (query.entityId) where.push(`entity_id = $${params.push(query.entityId)}`);
        if (query.actorId) where.push(`actor_id = $${params.push(query.actorId)}`);
        if (query.beforeId) where.push(`id < $${params.push(query.beforeId)}`);
        const rows = await deps.db.query<{
          id: number;
          at: Date;
          actor_type: 'user' | 'device' | 'system';
          actor_id: string | null;
          actor_label: string | null;
          action: string;
          entity_type: string;
          entity_id: string | null;
          before: unknown;
          after: unknown;
          ip: string | null;
        }>(`SELECT id, at, actor_type, actor_id, actor_label, action, entity_type, entity_id, before, after, host(ip) AS ip FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.push(query.limit)}`, params);
        return rows.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          actorType: r.actor_type,
          actorId: r.actor_id,
          actorLabel: r.actor_label,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          before: r.before ?? null,
          after: r.after ?? null,
          ip: r.ip,
        }));
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/api/settings/alerts',
      tag: 'settings',
      summary: 'The alert settings: offline threshold, e-mail recipients',
      auth: { perm: 'alerts:read' },
      responses: { 200: AlertSettings },
      handler: ({ deps }) => getAlertSettings(deps.db, deps.config),
    }),
    defineRoute({
      method: 'PUT',
      path: '/api/settings/alerts',
      tag: 'settings',
      summary: 'Change the alert settings',
      auth: { perm: 'settings:manage' },
      body: AlertSettings,
      responses: { 200: AlertSettings },
      handler: async ({ body, user, req, deps }) =>
        deps.db.tx(async (tx) => {
          const before = await getAlertSettings(deps.db, deps.config, tx);
          await putAlertSettings(deps.db, body, user.id, tx);
          await audit(deps.db, tx, actorOf(req), { action: 'settings.alerts', entityType: 'settings', entityId: 'alerts', before, after: body });
          return getAlertSettings(deps.db, deps.config, tx);
        }),
    }),
  ];
}
