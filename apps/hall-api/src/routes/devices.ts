// The fleet and each device: presence, version, IPs, last state, events, alerts; rename, move to
// another site, revoke.
import { v1 } from '@hall/protocol';
import { z } from 'zod';
import { actorOf, audit } from '../audit.js';
import { scopeOf, siteScopeSql } from '../auth/rbac.js';
import type { Deps, SessionUser } from '../context.js';
import type { Queryable } from '../db.js';
import { conflict, notFound } from '../http/errors.js';
import { defineRoute, type AnyRoute } from '../http/route.js';
import { DeviceDetail, DeviceEventRow, DeviceMetrics, DevicePresence, Fleet, type FleetDevice, HeartbeatRow, IdParams, limitQuery, Uuid } from '../schemas.js';
import { alertsOf } from './alerts.js';
import { siteInScope } from './org.js';

type FleetDeviceView = z.infer<typeof FleetDevice>;

/** Online: a message within the last three heartbeat intervals. */
export const onlineWindowS = (deps: Deps) => 3 * deps.config.intervals.heartbeatS;

interface DeviceRow {
  id: string;
  name: string;
  status: 'active' | 'revoked';
  last_seen_at: Date | null;
  orquestra_version: string | null;
  protocol_version: number | null;
  public_ip: string | null;
  lan_ip: string | null;
  uptime_s: number | null;
  image_digest: string | null;
  control_mode: v1.ControlMode | null;
  last_state: v1.DeviceState | null;
  site_id: string;
  site_name: string;
  customer_id: string;
  customer_name: string;
  reseller_id: string | null;
  reseller_name: string | null;
  open_alerts: number;
  critical_alerts: number;
  enrolled_at: Date;
  hostname: string | null;
  serial: string | null;
  model: string | null;
  api_version: string | null;
  public_key: string;
  enrolled_ip: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  last_heartbeat_at: Date | null;
  last_state_at: Date | null;
}

function fleetView(r: DeviceRow, deps: Deps, now: Date): FleetDeviceView {
  const online = r.last_seen_at !== null && now.getTime() - r.last_seen_at.getTime() <= onlineWindowS(deps) * 1000;
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    presence: r.status === 'revoked' ? 'revoked' : online ? 'online' : 'offline',
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    version: r.orquestra_version,
    protocolVersion: r.protocol_version,
    publicIp: r.public_ip,
    lanIp: r.lan_ip,
    uptimeS: r.uptime_s,
    imageDigest: r.image_digest,
    controlMode: r.control_mode,
    healthOk: r.last_state ? r.last_state.health.ok : null,
    site: { id: r.site_id, name: r.site_name },
    customer: { id: r.customer_id, name: r.customer_name },
    reseller: r.reseller_id ? { id: r.reseller_id, name: r.reseller_name ?? '' } : null,
    openAlerts: r.open_alerts,
    criticalAlerts: r.critical_alerts,
    enrolledAt: r.enrolled_at.toISOString(),
  };
}

async function deviceRows(deps: Deps, user: SessionUser, filter: { id?: string; siteId?: string; customerId?: string } = {}, on?: Queryable): Promise<DeviceRow[]> {
  const params: unknown[] = [];
  const where = [siteScopeSql(scopeOf(user, 'fleet:read')!, params)];
  if (filter.id) where.push(`d.id = $${params.push(filter.id)}`);
  if (filter.siteId) where.push(`d.site_id = $${params.push(filter.siteId)}`);
  if (filter.customerId) where.push(`s.customer_id = $${params.push(filter.customerId)}`);
  return deps.db.query<DeviceRow>(
    `SELECT d.*, s.name AS site_name, c.id AS customer_id, c.legal_name AS customer_name, r.id AS reseller_id, r.name AS reseller_name,
            coalesce(al.open, 0) AS open_alerts, coalesce(al.critical, 0) AS critical_alerts
       FROM devices d
       JOIN sites s ON s.id = d.site_id
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN resellers r ON r.id = c.reseller_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS open, count(*) FILTER (WHERE a.severity = 'critical') AS critical
           FROM alerts a WHERE a.device_id = d.id AND a.status <> 'closed'
       ) al ON TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY d.status, lower(c.legal_name), lower(s.name), lower(d.name)`,
    params,
    on,
  );
}

async function detail(deps: Deps, user: SessionUser, id: string, on?: Queryable): Promise<z.infer<typeof DeviceDetail>> {
  const r = (await deviceRows(deps, user, { id }, on))[0];
  if (!r) throw notFound('device');
  const lastState = r.last_state ? v1.DeviceState.safeParse(r.last_state) : undefined;
  return {
    ...fleetView(r, deps, deps.now()),
    hostname: r.hostname,
    serial: r.serial,
    model: r.model,
    apiVersion: r.api_version,
    publicKey: r.public_key,
    enrolledIp: r.enrolled_ip,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokeReason: r.revoke_reason,
    lastHeartbeatAt: r.last_heartbeat_at?.toISOString() ?? null,
    lastStateAt: r.last_state_at?.toISOString() ?? null,
    lastState: lastState?.success ? lastState.data : null,
    alerts: await alertsOf(deps, user, { deviceId: id, active: true }, on),
  };
}

const FleetQuery = z.object({ siteId: Uuid.optional(), customerId: Uuid.optional() });
const PresenceQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 14).default(24).describe('How far back (hours, default 24, at most 336)'),
});
const EventsQuery = z.object({
  limit: limitQuery(100, 1000),
  beforeId: z.coerce.number().int().optional().describe('Events older than this row id (paging)'),
});
const DevicePatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  siteId: Uuid.optional().describe('Move the device to another site'),
});
const RevokeBody = z.object({ reason: z.string().trim().min(1).max(500) });

export function fleetRoutes(): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/api/fleet',
      tag: 'devices',
      summary: 'The fleet: every device in your scope with its presence, version, IPs and open alerts',
      auth: { perm: 'fleet:read' },
      query: FleetQuery,
      responses: { 200: Fleet },
      handler: async ({ query, user, deps }) => {
        const now = deps.now();
        const devices = (await deviceRows(deps, user, query)).map((r) => fleetView(r, deps, now));
        return {
          generatedAt: now.toISOString(),
          onlineWindowS: onlineWindowS(deps),
          summary: {
            total: devices.length,
            online: devices.filter((d) => d.presence === 'online').length,
            offline: devices.filter((d) => d.presence === 'offline').length,
            revoked: devices.filter((d) => d.presence === 'revoked').length,
            withAlerts: devices.filter((d) => d.openAlerts > 0).length,
            openAlerts: devices.reduce((n, d) => n + d.openAlerts, 0),
          },
          devices,
        };
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/api/devices/:id',
      tag: 'devices',
      summary: 'One device: identity, presence, last state, open alerts',
      auth: { perm: 'fleet:read' },
      params: IdParams,
      responses: { 200: DeviceDetail },
      errors: [404],
      handler: ({ params, user, deps }) => detail(deps, user, params.id),
    }),
    defineRoute({
      method: 'PATCH',
      path: '/api/devices/:id',
      tag: 'devices',
      summary: 'Rename a device, or move it to another site (its history stays with it)',
      auth: { perm: 'devices:manage' },
      params: IdParams,
      body: DevicePatch,
      responses: { 200: DeviceDetail },
      errors: [404],
      handler: async ({ params, body, user, req, deps }) => {
        return deps.db.tx(async (tx) => {
          const before = await detail(deps, user, params.id, tx);
          await siteInScope(deps, user, before.site.id, 'devices:manage', tx);
          if (body.siteId) await siteInScope(deps, user, body.siteId, 'devices:manage', tx);
          await deps.db.query('UPDATE devices SET name = coalesce($2, name), site_id = coalesce($3, site_id), updated_at = now() WHERE id = $1', [params.id, body.name ?? null, body.siteId ?? null], tx);
          const after = await detail(deps, user, params.id, tx);
          await audit(deps.db, tx, actorOf(req), {
            action: body.siteId && body.siteId !== before.site.id ? 'device.transfer' : 'device.update',
            entityType: 'device',
            entityId: params.id,
            before: { name: before.name, siteId: before.site.id },
            after: { name: after.name, siteId: after.site.id },
          });
          return after;
        });
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/api/devices/:id/revoke',
      tag: 'devices',
      summary: 'Revoke a device: Hall refuses its requests from now on (403 device-revoked) and closes its alerts',
      auth: { perm: 'devices:manage' },
      params: IdParams,
      body: RevokeBody,
      responses: { 200: DeviceDetail },
      errors: [404, 409],
      handler: async ({ params, body, user, req, deps }) => {
        return deps.db.tx(async (tx) => {
          const before = await detail(deps, user, params.id, tx);
          await siteInScope(deps, user, before.site.id, 'devices:manage', tx);
          if (before.status === 'revoked') throw conflict('this device is already revoked');
          const now = deps.now();
          await deps.db.query("UPDATE devices SET status = 'revoked', revoked_at = $2, revoked_by = $3, revoke_reason = $4, updated_at = $2 WHERE id = $1", [params.id, now, user.id, body.reason], tx);
          await deps.db.query("UPDATE alerts SET status = 'closed', closed_at = $2, closed_by = $3, close_reason = 'manual', close_note = 'device revoked' WHERE device_id = $1 AND status <> 'closed'", [params.id, now, user.id], tx);
          await audit(deps.db, tx, actorOf(req), { action: 'device.revoke', entityType: 'device', entityId: params.id, before: { status: before.status }, after: { status: 'revoked', reason: body.reason } });
          return detail(deps, user, params.id, tx);
        });
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/api/devices/:id/presence',
      tag: 'devices',
      summary: 'Heartbeats per bucket over the last hours (5-minute buckets up to 48 h, then hourly)',
      auth: { perm: 'fleet:read' },
      params: IdParams,
      query: PresenceQuery,
      responses: { 200: DevicePresence },
      errors: [404],
      handler: async ({ params, query, user, deps }) => {
        await detail(deps, user, params.id);
        const bucketS = query.hours <= 48 ? 300 : 3600;
        const to = deps.now();
        const end = Math.ceil(to.getTime() / 1000 / bucketS) * bucketS;
        const start = end - query.hours * 3600;
        const rows = await deps.db.query<{ b: number; n: number }>(
          `SELECT floor(extract(epoch FROM received_at) / $3)::bigint * $3 AS b, count(*) AS n
             FROM heartbeats WHERE device_id = $1 AND received_at >= to_timestamp($2)
            GROUP BY 1 ORDER BY 1`,
          [params.id, start, bucketS],
        );
        const counts = new Map(rows.map((r) => [Number(r.b), r.n]));
        const buckets = [];
        for (let t = start; t < end; t += bucketS) buckets.push({ start: new Date(t * 1000).toISOString(), heartbeats: counts.get(t) ?? 0 });
        return {
          from: new Date(start * 1000).toISOString(),
          to: to.toISOString(),
          bucketS,
          expectedPerBucket: bucketS / deps.config.intervals.heartbeatS,
          buckets,
        };
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/api/devices/:id/metrics',
      tag: 'devices',
      summary: 'The states over the last hours: control mode, health, CPU, memory, disk, temperature',
      auth: { perm: 'fleet:read' },
      params: IdParams,
      query: PresenceQuery,
      responses: { 200: DeviceMetrics },
      errors: [404],
      handler: async ({ params, query, user, deps }) => {
        await detail(deps, user, params.id);
        const from = new Date(deps.now().getTime() - query.hours * 3600_000);
        const rows = await deps.db.query<{ received_at: Date; control_mode: string; health_ok: boolean; cpu_pct: number | null; mem_pct: number | null; disk_pct: number | null; temperature_c: number | null }>(
          `SELECT received_at, control_mode, health_ok, cpu_pct, mem_pct, disk_pct, temperature_c
             FROM device_states WHERE device_id = $1 AND received_at >= $2 ORDER BY received_at LIMIT 5000`,
          [params.id, from],
        );
        return {
          points: rows.map((r) => ({
            at: r.received_at.toISOString(),
            controlMode: r.control_mode,
            healthOk: r.health_ok,
            cpuPct: r.cpu_pct,
            memPct: r.mem_pct,
            diskPct: r.disk_pct,
            temperatureC: r.temperature_c,
          })),
        };
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/api/devices/:id/events',
      tag: 'devices',
      summary: "The device's warning and critical events, newest first",
      auth: { perm: 'fleet:read' },
      params: IdParams,
      query: EventsQuery,
      responses: { 200: z.array(DeviceEventRow) },
      errors: [404],
      handler: async ({ params, query, user, deps }) => {
        await detail(deps, user, params.id);
        const rows = await deps.db.query<{
          id: number;
          event_id: string;
          occurred_at: Date;
          received_at: Date;
          severity: 'warning' | 'critical';
          kind: string;
          source: string;
          message: string;
          charger_id: string | null;
          connector_id: number | null;
          data: Record<string, unknown> | null;
        }>(
          `SELECT * FROM device_events WHERE device_id = $1 AND ($2::bigint IS NULL OR id < $2)
            ORDER BY occurred_at DESC, id DESC LIMIT $3`,
          [params.id, query.beforeId ?? null, query.limit],
        );
        return rows.map((r) => ({
          id: r.id,
          eventId: r.event_id,
          occurredAt: r.occurred_at.toISOString(),
          receivedAt: r.received_at.toISOString(),
          severity: r.severity,
          kind: r.kind,
          source: r.source,
          message: r.message,
          chargerId: r.charger_id,
          connectorId: r.connector_id,
          data: r.data,
        }));
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/api/devices/:id/heartbeats',
      tag: 'devices',
      summary: 'The latest heartbeats, newest first',
      auth: { perm: 'fleet:read' },
      params: IdParams,
      query: z.object({ limit: limitQuery(60, 1000) }),
      responses: { 200: z.array(HeartbeatRow) },
      errors: [404],
      handler: async ({ params, query, user, deps }) => {
        await detail(deps, user, params.id);
        const rows = await deps.db.query<{ received_at: Date; version: string | null; uptime_s: number | null; public_ip: string | null; lan_ip: string | null }>(
          'SELECT received_at, version, uptime_s, host(public_ip) AS public_ip, host(lan_ip) AS lan_ip FROM heartbeats WHERE device_id = $1 ORDER BY received_at DESC LIMIT $2',
          [params.id, query.limit],
        );
        return rows.map((r) => ({ receivedAt: r.received_at.toISOString(), version: r.version, uptimeS: r.uptime_s, publicIp: r.public_ip, lanIp: r.lan_ip }));
      },
    }),
  ];
}
