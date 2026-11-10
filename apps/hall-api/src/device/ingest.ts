// The device side of the API: the Hall protocol (packages/protocol, protocol/v1). Each route is
// documented with the protocol's own operation, so Hall's contract and the protocol's agree.
import {
  CLAIM_CODE_TTL_H,
  DEVICE_PATHS,
  isWellFormedClaimCode,
  normalizeClaimCode,
  parseMessage,
  PROTOCOL_OPERATIONS,
  sha256Hex,
  type CurrentMessages,
  type MessageKind,
  type v1,
} from '@hall/protocol';
import { audit } from '../audit.js';
import type { Notice } from '../alerts/engine.js';
import { Lockout } from '../auth/lockout.js';
import type { Deps } from '../context.js';
import { HttpError } from '../http/errors.js';
import { defineRoute, type AnyRoute } from '../http/route.js';
import { clientIp, verifyEnrolment } from './auth.js';

/** The protocol operation of a path (its summary, headers, body and answers). */
function protocolDoc(path: string) {
  const op = PROTOCOL_OPERATIONS.find((o) => o.path === path);
  if (!op) throw new Error(`no protocol operation for ${path}`);
  return { operationId: op.operationId, summary: op.summary, description: op.description, headers: op.headers, docBody: op.body, responses: op.responses };
}

/** A device message, validated in its own protocol version and upgraded to the current one. */
function parse<K extends MessageKind>(kind: K, body: unknown): { version: number; message: CurrentMessages[K] } {
  const r = parseMessage(kind, body);
  if (r.ok) return { version: r.version, message: r.message };
  if (r.reason === 'unsupported-protocol') {
    throw new HttpError(422, 'unsupported-protocol', `protocolVersion ${JSON.stringify(r.version)} is not accepted`, {
      supportedVersions: r.supported,
      hint: `send one of: ${r.supported.join(', ')}`,
    });
  }
  throw new HttpError(422, 'invalid', `Invalid ${kind} message: ${r.issues.map((i) => `${i.path || '(body)'}: ${i.message}`).join('; ')}`, { issues: r.issues });
}

const ack = (deps: Deps, version: number, at: Date, extra: Partial<v1.Ack> = {}): v1.Ack => ({
  protocolVersion: version,
  accepted: true,
  receivedAt: at.toISOString(),
  intervals: deps.config.intervals,
  ...extra,
});

/** The claim code's failed attempts per address: 20 in 15 minutes. */
const ENROL_MAX_FAILURES = 20;
const ENROL_WINDOW_MS = 15 * 60_000;

export function deviceRoutes(): AnyRoute[] {
  const enrolLockout = new Lockout(ENROL_MAX_FAILURES, ENROL_WINDOW_MS);

  const enrol = defineRoute({
    method: 'POST',
    path: DEVICE_PATHS.enrol,
    tag: 'device',
    auth: 'enrol',
    ...protocolDoc(DEVICE_PATHS.enrol),
    handler: async ({ req, reply, deps }) => {
      const { version, message: m } = parse('enrol', req.body);
      const ip = clientIp(req);
      const nowMs = deps.now().getTime();
      const retryAfterS = enrolLockout.retryAfterS(ip, nowMs);
      if (retryAfterS) {
        void reply.header('retry-after', String(retryAfterS));
        throw new HttpError(429, 'rate-limited', 'too many failed claim codes from this address', { retryAfterS });
      }
      await verifyEnrolment(deps, req, m.publicKey);
      const failed = (code: string, status: number, message: string, hint: string) => {
        enrolLockout.fail(ip, nowMs);
        return new HttpError(status, code, message, { hint });
      };
      const normalized = normalizeClaimCode(m.claimCode);
      if (!isWellFormedClaimCode(normalized)) throw failed('claim-code-invalid', 404, 'no such claim code', 'check the code, or ask for a new one');
      const at = deps.now();
      const result = await deps.db.tx(async (tx) => {
        const cc = await deps.db.one<{ id: string; site_id: string; used_at: Date | null; revoked_at: Date | null; expires_at: Date }>(
          'SELECT id, site_id, used_at, revoked_at, expires_at FROM claim_codes WHERE code_hash = $1 FOR UPDATE',
          [Buffer.from(sha256Hex(normalized), 'hex')],
          tx,
        );
        if (!cc || cc.revoked_at) throw failed('claim-code-invalid', 404, 'no such claim code', 'check the code, or ask for a new one');
        if (cc.used_at) throw failed('claim-code-used', 410, 'this claim code was already used', 'a claim code enrols one device: ask for a new one');
        if (cc.expires_at <= at) throw failed('claim-code-expired', 410, `this claim code expired (they live ${CLAIM_CODE_TTL_H} h)`, 'ask for a new one');
        const existing = await deps.db.one('SELECT id FROM devices WHERE public_key = $1', [m.publicKey], tx);
        if (existing) throw new HttpError(409, 'already-enrolled', 'this public key is already enrolled', { hint: 'keep using the deviceId you were given, or generate a new key' });
        const site = await deps.db.one<{ id: string; name: string; customer_id: string; customer_name: string }>(
          'SELECT s.id, s.name, s.customer_id, c.legal_name AS customer_name FROM sites s JOIN customers c ON c.id = s.customer_id WHERE s.id = $1',
          [cc.site_id],
          tx,
        );
        if (!site) throw new HttpError(404, 'claim-code-invalid', 'the site of this claim code is gone');
        const d = m.device;
        const name = d.hostname ?? site.name;
        const device = await deps.db.one<{ id: string }>(
          `INSERT INTO devices (site_id, name, public_key, claim_code_id, enrolled_at, enrolled_ip, hostname, serial, model,
                                orquestra_version, api_version, image_digest, protocol_version, last_seen_at, public_ip)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $5, $6) RETURNING id`,
          [site.id, name, m.publicKey, cc.id, at, ip, d.hostname ?? null, d.serial ?? null, d.model ?? null, d.orquestraVersion, d.apiVersion ?? null, d.imageDigest ?? null, version],
          tx,
        );
        await deps.db.query('UPDATE claim_codes SET used_at = $2, device_id = $3 WHERE id = $1', [cc.id, at, device!.id], tx);
        await audit(deps.db, tx, { type: 'device', id: device!.id, label: name, ip, userAgent: null }, {
          action: 'device.enrol',
          entityType: 'device',
          entityId: device!.id,
          after: { siteId: site.id, name, publicKey: m.publicKey, claimCodeId: cc.id, device: d },
        });
        return { deviceId: device!.id, site };
      });
      enrolLockout.clear(ip);
      void reply.code(201);
      const res: v1.EnrolResponse = {
        protocolVersion: version,
        deviceId: result.deviceId,
        site: { id: result.site.id, name: result.site.name },
        customer: { id: result.site.customer_id, name: result.site.customer_name },
        enrolledAt: at.toISOString(),
        serverTime: deps.now().toISOString(),
        intervals: deps.config.intervals,
      };
      return res;
    },
  });

  const heartbeat = defineRoute({
    method: 'POST',
    path: DEVICE_PATHS.heartbeat,
    tag: 'device',
    auth: 'device',
    ...protocolDoc(DEVICE_PATHS.heartbeat),
    handler: async ({ req, deps, device }) => {
      const { version, message: m } = parse('heartbeat', req.body);
      const at = deps.now();
      const ip = clientIp(req);
      const notices = await deps.db.tx(async (tx) => {
        await deps.db.query(
          `UPDATE devices SET last_seen_at = $2, last_heartbeat_at = $2, orquestra_version = $3, uptime_s = $4, public_ip = $5, lan_ip = $6,
                  image_digest = coalesce($7, image_digest), api_version = coalesce($8, api_version), protocol_version = $9, updated_at = $2
            WHERE id = $1`,
          [device.id, at, m.version, m.uptimeS, ip, m.lanIp ?? null, m.imageDigest ?? null, m.apiVersion ?? null, version],
          tx,
        );
        await deps.db.query(
          `INSERT INTO heartbeats (device_id, received_at, sent_at, version, uptime_s, public_ip, lan_ip, image_digest, protocol_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [device.id, at, m.sentAt, m.version, m.uptimeS, ip, m.lanIp ?? null, m.imageDigest ?? null, version],
          tx,
        );
        return deps.alerts.onMessage(tx, device, at);
      });
      deps.alerts.deliver(notices);
      return ack(deps, version, at, { publicIp: ip });
    },
  });

  const state = defineRoute({
    method: 'POST',
    path: DEVICE_PATHS.state,
    tag: 'device',
    auth: 'device',
    ...protocolDoc(DEVICE_PATHS.state),
    handler: async ({ req, deps, device }) => {
      const { version, message: m } = parse('state', req.body);
      const at = deps.now();
      const notices = await deps.db.tx(async (tx): Promise<Notice[]> => {
        const payload = JSON.stringify(m);
        await deps.db.query(
          `INSERT INTO device_states (device_id, received_at, sent_at, protocol_version, control_mode, health_ok, cpu_pct, mem_pct, disk_pct, temperature_c, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [device.id, at, m.sentAt, version, m.control.mode, m.health.ok, m.resources.cpuPct, m.resources.memPct, m.resources.diskPct, m.resources.temperatureC, payload],
          tx,
        );
        await deps.db.query(
          'UPDATE devices SET last_seen_at = $2, last_state_at = $2, last_state = $3, control_mode = $4, protocol_version = $5, updated_at = $2 WHERE id = $1',
          [device.id, at, payload, m.control.mode, version],
          tx,
        );
        return [...(await deps.alerts.onMessage(tx, device, at)), ...(await deps.alerts.onState(tx, device, m, at))];
      });
      deps.alerts.deliver(notices);
      return ack(deps, version, at);
    },
  });

  const events = defineRoute({
    method: 'POST',
    path: DEVICE_PATHS.events,
    tag: 'device',
    auth: 'device',
    ...protocolDoc(DEVICE_PATHS.events),
    handler: async ({ req, deps, device }) => {
      const { version, message: m } = parse('events', req.body);
      const at = deps.now();
      const { notices, accepted } = await deps.db.tx(async (tx) => {
        const fresh: v1.DeviceEvent[] = [];
        for (const e of m.events) {
          const row = await deps.db.one(
            `INSERT INTO device_events (device_id, event_id, occurred_at, received_at, severity, kind, source, message, charger_id, connector_id, meter_id, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (device_id, event_id) DO NOTHING RETURNING id`,
            [device.id, e.id, e.timestamp, at, e.severity, e.kind, e.source, e.message, e.chargerId ?? null, e.connectorId ?? null, e.meterId ?? null, e.data ? JSON.stringify(e.data) : null],
            tx,
          );
          if (row) fresh.push(e);
        }
        await deps.db.query('UPDATE devices SET last_seen_at = $2, updated_at = $2 WHERE id = $1', [device.id, at], tx);
        const n = [...(await deps.alerts.onMessage(tx, device, at)), ...(await deps.alerts.onEvents(tx, device, fresh, at))];
        return { notices: n, accepted: fresh.length };
      });
      deps.alerts.deliver(notices);
      return ack(deps, version, at, { events: { accepted, duplicates: m.events.length - accepted } });
    },
  });

  return [enrol, heartbeat, state, events];
}
