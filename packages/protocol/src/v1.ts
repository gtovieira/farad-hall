// The Hall protocol, version 1: what the Orquestra's hall-agent sends to Farad Hall, and what Hall
// answers. These schemas are the contract (protocol/v1/*.json is generated from them).
//
// Compatibility rules of a version:
// - every object may carry fields this version does not list: the receiver ignores them (an agent
//   may send more; Hall may answer more);
// - an enum is closed within a version: a new value is a new protocol version;
// - a field is never removed, renamed or retyped within a version.
import { z } from 'zod';

export const VERSION = 1 as const;

const IsoTime = z.iso.datetime({ offset: true }).describe('ISO-8601 time, UTC or with an offset, e.g. 2026-11-10T14:03:00.000Z');
const Version = z.literal(VERSION).describe('The protocol version this message is written in');

export const IpAddress = z.union([z.ipv4(), z.ipv6()]).describe('An IPv4 or IPv6 address');
/** An Ed25519 public key: its 32 raw bytes, base64url without padding (43 characters). */
export const PublicKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'an Ed25519 public key: 32 bytes, base64url, no padding')
  .describe('Ed25519 public key: the 32 raw bytes, base64url without padding (the JWK "x" value)');
/** A container image digest. */
export const ImageDigest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'sha256:<64 hex digits>')
  .describe('The running image digest, sha256:<64 hex>');
const Short = (max: number) => z.string().min(1).max(max);

// ------------------------------------------------------------------------- enrolment --

export const DeviceInfo = z
  .object({
    orquestraVersion: Short(64).describe("The Orquestra's software version (FARAD_VERSION), e.g. v1.4.0"),
    apiVersion: Short(32).optional().describe("The Orquestra's local API version, e.g. 1.1.0"),
    imageDigest: ImageDigest.optional(),
    hostname: Short(128).optional(),
    serial: Short(128).optional().describe("The board's serial number, when it has one"),
    model: Short(128).optional().describe('The board, e.g. Raspberry Pi 5 Model B Rev 1.0'),
    siteName: Short(200).optional().describe("The site's name set in the Orquestra (Settings › Site)"),
  })
  .describe('What the device says about itself when it enrols');

export const EnrolRequest = z
  .object({
    protocolVersion: Version,
    claimCode: z.string().min(8).max(20).describe('The claim code an admin created in Hall, e.g. K7QM-4TZP (case, dashes and spaces are ignored)'),
    publicKey: PublicKey,
    device: DeviceInfo,
  })
  .describe('Enrolment: the device presents a claim code and the public key it generated. The request is signed with that key.');

export const Intervals = z
  .object({
    heartbeatS: z.number().int().min(10).max(3600).describe('Send a heartbeat this often (seconds)'),
    stateS: z.number().int().min(30).max(3600).describe('Send the state this often (seconds), and on a change of control mode'),
  })
  .describe('How often Hall wants each message');

export const EnrolResponse = z.object({
  protocolVersion: z.number().int().describe('The protocol version Hall accepted the request in, and answers in'),
  deviceId: z.uuid().describe("The device's identity in Hall: the Hall-Device header of every later request"),
  site: z.object({ id: z.uuid(), name: z.string() }),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  enrolledAt: IsoTime,
  serverTime: IsoTime,
  intervals: Intervals,
});

// ------------------------------------------------------------------------- heartbeat --

export const Heartbeat = z
  .object({
    protocolVersion: Version,
    sentAt: IsoTime.describe("The device's clock when it sent this"),
    version: Short(64).describe("The Orquestra's software version (FARAD_VERSION)"),
    uptimeS: z.number().int().nonnegative().describe("Seconds since the device's boot"),
    lanIp: IpAddress.optional().describe("The device's address on the site LAN"),
    imageDigest: ImageDigest.optional(),
    apiVersion: Short(32).optional().describe("The Orquestra's local API version"),
  })
  .describe('Presence, every minute. Hall records the public IP it sees the request come from.');

// ----------------------------------------------------------------------------- state --

export const ServiceHealth = z.object({
  name: Short(64).describe('The service, e.g. control-engine'),
  ok: z.boolean(),
  status: Short(64).optional().describe("Docker's state, e.g. healthy, unhealthy, restarting"),
  restarts: z.number().int().nonnegative().optional().describe('Restarts since the device booted'),
  detail: z.string().max(500).optional(),
});

export const Resources = z.object({
  cpuPct: z.number().min(0).max(100),
  memPct: z.number().min(0).max(100),
  memTotalMb: z.number().nonnegative().optional(),
  diskPct: z.number().min(0).max(100).describe('Use of the data disk'),
  diskFreeGb: z.number().nonnegative().optional(),
  temperatureC: z.number().min(-60).max(200).nullable().describe('The SoC temperature; null when the board has no sensor'),
  loadAvg1: z.number().nonnegative().optional(),
  watchdogResets: z.number().int().nonnegative().optional().describe('Hardware watchdog resets since installation'),
});

/** The Orquestra's control modes (packages/shared ControlMode). */
export const ControlMode = z
  .enum(['normal', 'fallback-analyzer', 'fallback-error', 'no-settings'])
  .describe('normal; fallback-analyzer (main meter lost: floors only); fallback-error (control degraded); no-settings (site not configured: floors only)');

export const ControlState = z.object({
  mode: ControlMode,
  since: IsoTime.optional().describe('When the current mode began'),
  mainMeterOnline: z.boolean(),
  invariant: z.enum(['ok', 'violated', 'unverified']).optional().describe('The fallback invariant (floors fit under the limit)'),
  activeSessions: z.number().int().nonnegative().optional(),
  pausedSessions: z.number().int().nonnegative().optional(),
});

/** OCPP 1.6 ChargePointStatus. */
export const ConnectorStatus = z.enum([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
]);

export const ConnectorState = z.object({
  connectorId: z.number().int().min(0).max(64),
  status: ConnectorStatus.nullable().describe('The last StatusNotification; null when it never sent one'),
  errorCode: Short(64).optional().describe('The OCPP error code, when not NoError'),
});

export const ChargerState = z.object({
  chargerId: Short(64),
  online: z.boolean().describe('Its OCPP connection is open'),
  vendor: Short(64).optional(),
  model: Short(64).optional(),
  firmware: Short(64).optional(),
  connectors: z.array(ConnectorState).max(64),
});

export const DeviceState = z
  .object({
    protocolVersion: Version,
    sentAt: IsoTime,
    health: z.object({
      ok: z.boolean().describe('Every service is healthy'),
      services: z.array(ServiceHealth).max(64),
    }),
    resources: Resources,
    control: ControlState,
    chargers: z.array(ChargerState).max(500),
  })
  .describe('Health, resources, control and chargers: every 5 minutes, and at once when the control mode changes');

// ---------------------------------------------------------------------------- events --

export const EventSeverity = z.enum(['warning', 'critical']);

export const DeviceEvent = z.object({
  id: Short(64).describe("The Orquestra's event id (a uuid): Hall keeps one copy per id, so a batch may be sent again"),
  timestamp: IsoTime,
  source: Short(64).describe('The service that raised it, e.g. control-engine'),
  kind: Short(64).describe("The Orquestra's EventKind, e.g. fallback-entered (open: new kinds need no new protocol version)"),
  severity: EventSeverity,
  message: z.string().max(2000),
  chargerId: Short(64).optional(),
  connectorId: z.number().int().min(0).max(64).optional(),
  meterId: Short(64).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const EventBatch = z
  .object({
    protocolVersion: Version,
    events: z.array(DeviceEvent).min(1).max(500),
  })
  .describe("The Orquestra's warning and critical events, as they happen; what could not be sent, later, oldest first");

// ------------------------------------------------------------------------------ ack --

export const Ack = z
  .object({
    protocolVersion: z.number().int().describe('The protocol version Hall accepted the message in'),
    accepted: z.literal(true),
    receivedAt: IsoTime.describe("Hall's clock when it took the message: the agent corrects its clock offset with it"),
    publicIp: IpAddress.optional().describe('The address Hall saw the request come from (heartbeat)'),
    events: z
      .object({
        accepted: z.number().int().nonnegative(),
        duplicates: z.number().int().nonnegative().describe('Events Hall already had (same id): not stored again'),
      })
      .optional(),
    intervals: Intervals.optional().describe('When Hall wants other intervals from now on'),
  })
  .describe("Hall's acknowledgement: the message is stored. Anything but a 2xx means: keep it and send it again later.");

// ---------------------------------------------------------------------------- errors --

export const DeviceErrorCode = z.enum([
  'invalid',
  'bad-request',
  'unsupported-protocol',
  'unauthorized',
  'bad-signature',
  'stale-timestamp',
  'replayed-nonce',
  'unknown-device',
  'device-revoked',
  'claim-code-invalid',
  'claim-code-expired',
  'claim-code-used',
  'already-enrolled',
  'rate-limited',
  'internal',
]);

export const DeviceError = z.object({
  error: DeviceErrorCode.or(z.string()).describe('A machine code (DeviceErrorCode); the set may grow'),
  message: z.string(),
  hint: z.string().optional(),
  serverTime: IsoTime.optional().describe("Hall's clock, on a stale-timestamp: correct the offset and send again"),
  supportedVersions: z.array(z.number().int()).optional().describe('On unsupported-protocol: the versions Hall accepts'),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type DeviceInfo = z.infer<typeof DeviceInfo>;
export type EnrolRequest = z.infer<typeof EnrolRequest>;
export type EnrolResponse = z.infer<typeof EnrolResponse>;
export type Intervals = z.infer<typeof Intervals>;
export type Heartbeat = z.infer<typeof Heartbeat>;
export type ServiceHealth = z.infer<typeof ServiceHealth>;
export type Resources = z.infer<typeof Resources>;
export type ControlMode = z.infer<typeof ControlMode>;
export type ControlState = z.infer<typeof ControlState>;
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;
export type ChargerState = z.infer<typeof ChargerState>;
export type DeviceState = z.infer<typeof DeviceState>;
export type DeviceEvent = z.infer<typeof DeviceEvent>;
export type EventBatch = z.infer<typeof EventBatch>;
export type Ack = z.infer<typeof Ack>;
export type DeviceErrorCode = z.infer<typeof DeviceErrorCode>;
export type DeviceError = z.infer<typeof DeviceError>;
