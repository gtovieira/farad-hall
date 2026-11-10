// The people API's models (components/schemas of docs/api/openapi.json). Field names are camelCase,
// times ISO-8601 strings in UTC, and a field every answer carries is present, null when empty.
import { SchemaNames } from '@hall/openapi';
import { protocolNames, v1 } from '@hall/protocol';
import { z } from 'zod';
import { Permission, Role } from './auth/rbac.js';
import { documentTypeOf, normalizeDocument } from './documents.js';
import { ErrorBody, ErrorCode } from './http/errors.js';
import { AlertSettings } from './settings.js';

export const apiNames = new SchemaNames().merge(protocolNames());
const add = <T extends z.ZodType>(name: string, s: T) => apiNames.add(name, s);

export const IsoTime = z.iso.datetime({ offset: true }).describe('ISO-8601 time, e.g. 2026-11-10T14:03:00.000Z');
export const Uuid = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));

add('Error', ErrorBody);
add('ErrorCode', ErrorCode);
add('Role', Role);
add('Permission', Permission);
add('AlertSettings', AlertSettings);

export const Ref = add('Ref', z.object({ id: Uuid, name: z.string() }));

// --------------------------------------------------------------------------- addresses --

export const Address = add(
  'Address',
  z.object({
    street: optionalText(200),
    number: optionalText(20),
    complement: optionalText(100),
    district: optionalText(100).describe('Bairro'),
    city: optionalText(100),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/, 'a state (UF), two upper-case letters, e.g. BA')
      .nullable()
      .optional()
      .describe('UF, e.g. BA'),
    postalCode: z
      .string()
      .regex(/^\d{5}-?\d{3}$/, 'a CEP, e.g. 40015-970')
      .nullable()
      .optional()
      .describe('CEP'),
  }),
);
export type Address = z.infer<typeof Address>;

export const Contact = add(
  'Contact',
  z.object({
    name: text(200),
    email: z.email().nullable().optional(),
    phone: optionalText(40),
    role: optionalText(100).describe('e.g. síndico, administradora, financeiro'),
  }),
);

/** A CPF or CNPJ, with or without punctuation; normalized and checked. */
export const TaxId = z
  .string()
  .transform(normalizeDocument)
  .refine((s) => documentTypeOf(s) !== undefined, 'a valid CPF (11 digits) or CNPJ (14 characters) with its check digits')
  .describe('CPF or CNPJ, with or without punctuation');

// --------------------------------------------------------------------------- resellers --

export const Reseller = add(
  'Reseller',
  z.object({
    id: Uuid,
    name: z.string(),
    document: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    customerCount: z.number().int(),
    createdAt: IsoTime,
    updatedAt: IsoTime,
  }),
);
export const ResellerInput = add(
  'ResellerWrite',
  z.object({
    name: text(200),
    document: TaxId.refine((s) => s.length === 14, 'a reseller is a company: a CNPJ').nullable().optional(),
    email: z.email().nullable().optional(),
    phone: optionalText(40),
  }),
);

// --------------------------------------------------------------------------- customers --

export const Customer = add(
  'Customer',
  z.object({
    id: Uuid,
    reseller: Ref.nullable(),
    legalName: z.string().describe('Razão social, or the person’s name'),
    tradeName: z.string().nullable().describe('Nome fantasia'),
    documentType: z.enum(['cnpj', 'cpf']),
    document: z.string(),
    address: Address,
    contacts: z.array(Contact),
    billingContact: Contact.nullable().describe('Responsável financeiro'),
    notes: z.string().nullable(),
    siteCount: z.number().int(),
    deviceCount: z.number().int(),
    createdAt: IsoTime,
    updatedAt: IsoTime,
  }),
);
export const CustomerInput = add(
  'CustomerWrite',
  z.object({
    resellerId: Uuid.nullable().optional(),
    legalName: text(200),
    tradeName: optionalText(200),
    document: TaxId,
    address: Address.optional(),
    contacts: z.array(Contact).max(20).optional(),
    billingContact: Contact.nullable().optional(),
    notes: optionalText(2000),
  }),
);

// ------------------------------------------------------------------------------- sites --

export const SiteKind = add('SiteKind', z.enum(['condominio', 'eletroposto', 'empresa', 'estacionamento']));

export const Site = add(
  'Site',
  z.object({
    id: Uuid,
    customer: Ref,
    reseller: Ref.nullable(),
    name: z.string(),
    kind: SiteKind,
    address: Address,
    utility: z.string().nullable().describe('Distribuidora, e.g. Coelba'),
    timezone: z.string(),
    deviceCount: z.number().int(),
    createdAt: IsoTime,
    updatedAt: IsoTime,
  }),
);
export const SiteInput = add(
  'SiteWrite',
  z.object({
    customerId: Uuid,
    name: text(200),
    kind: SiteKind,
    address: Address.optional(),
    utility: optionalText(100),
    timezone: z
      .string()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'an IANA time zone, e.g. America/Bahia')
      .default('America/Sao_Paulo'),
  }),
);

// ------------------------------------------------------------------------- claim codes --

export const ClaimCodeStatus = add('ClaimCodeStatus', z.enum(['active', 'used', 'expired', 'revoked']));
export const ClaimCode = add(
  'ClaimCode',
  z.object({
    id: Uuid,
    site: Ref,
    customer: Ref,
    label: z.string().nullable(),
    hint: z.string().describe('The last two characters, to tell codes apart: the code itself is shown once'),
    status: ClaimCodeStatus,
    createdAt: IsoTime,
    createdBy: z.string().nullable(),
    expiresAt: IsoTime,
    usedAt: IsoTime.nullable(),
    device: Ref.nullable(),
  }),
);
export const ClaimCodeCreated = add('ClaimCodeCreated', ClaimCode.extend({ code: z.string().describe('The claim code, e.g. K7QM-4TZP: shown only now') }));

// ----------------------------------------------------------------------------- devices --

export const Presence = add('Presence', z.enum(['online', 'offline', 'revoked']).describe('online: a message within the last 3 heartbeat intervals'));

export const FleetDevice = add(
  'FleetDevice',
  z.object({
    id: Uuid,
    name: z.string(),
    status: z.enum(['active', 'revoked']),
    presence: Presence,
    lastSeenAt: IsoTime.nullable(),
    version: z.string().nullable(),
    protocolVersion: z.number().int().nullable(),
    publicIp: z.string().nullable(),
    lanIp: z.string().nullable(),
    uptimeS: z.number().int().nullable(),
    imageDigest: z.string().nullable(),
    controlMode: v1.ControlMode.nullable(),
    healthOk: z.boolean().nullable(),
    site: Ref,
    customer: Ref,
    reseller: Ref.nullable(),
    openAlerts: z.number().int(),
    criticalAlerts: z.number().int(),
    enrolledAt: IsoTime,
  }),
);

export const Fleet = add(
  'Fleet',
  z.object({
    generatedAt: IsoTime,
    onlineWindowS: z.number().int(),
    summary: z.object({
      total: z.number().int(),
      online: z.number().int(),
      offline: z.number().int(),
      revoked: z.number().int(),
      withAlerts: z.number().int(),
      openAlerts: z.number().int(),
    }),
    devices: z.array(FleetDevice),
  }),
);

export const AlertRule = add('AlertRule', z.enum(['device-offline', 'control-fallback', 'critical-event']));
export const AlertStatus = add('AlertStatus', z.enum(['open', 'acknowledged', 'closed']));
export const Alert = add(
  'Alert',
  z.object({
    id: Uuid,
    rule: AlertRule,
    severity: v1.EventSeverity,
    status: AlertStatus,
    title: z.string(),
    details: z.record(z.string(), z.unknown()),
    occurrences: z.number().int(),
    openedAt: IsoTime,
    lastOccurredAt: IsoTime,
    acknowledgedAt: IsoTime.nullable(),
    acknowledgedBy: z.string().nullable(),
    ackNote: z.string().nullable(),
    closedAt: IsoTime.nullable(),
    closedBy: z.string().nullable(),
    closeReason: z.enum(['auto', 'manual']).nullable(),
    closeNote: z.string().nullable(),
    notifiedAt: IsoTime.nullable(),
    device: Ref,
    site: Ref,
    customer: Ref,
  }),
);

export const DeviceDetail = add(
  'DeviceDetail',
  FleetDevice.extend({
    hostname: z.string().nullable(),
    serial: z.string().nullable(),
    model: z.string().nullable(),
    apiVersion: z.string().nullable(),
    publicKey: z.string(),
    enrolledIp: z.string().nullable(),
    revokedAt: IsoTime.nullable(),
    revokeReason: z.string().nullable(),
    lastHeartbeatAt: IsoTime.nullable(),
    lastStateAt: IsoTime.nullable(),
    lastState: v1.DeviceState.nullable(),
    alerts: z.array(Alert).describe('Open and acknowledged alerts'),
  }),
);

export const DevicePresence = add(
  'DevicePresence',
  z.object({
    from: IsoTime,
    to: IsoTime,
    bucketS: z.number().int(),
    expectedPerBucket: z.number().describe('Heartbeats a bucket holds when the device is online all along'),
    buckets: z.array(z.object({ start: IsoTime, heartbeats: z.number().int() })),
  }),
);

export const DeviceMetrics = add(
  'DeviceMetrics',
  z.object({
    points: z.array(
      z.object({
        at: IsoTime,
        controlMode: z.string(),
        healthOk: z.boolean(),
        cpuPct: z.number().nullable(),
        memPct: z.number().nullable(),
        diskPct: z.number().nullable(),
        temperatureC: z.number().nullable(),
      }),
    ),
  }),
);

export const DeviceEventRow = add(
  'DeviceEventRow',
  z.object({
    id: z.number().int().describe("Hall's row id (for paging with beforeId)"),
    eventId: z.string(),
    occurredAt: IsoTime,
    receivedAt: IsoTime,
    severity: v1.EventSeverity,
    kind: z.string(),
    source: z.string(),
    message: z.string(),
    chargerId: z.string().nullable(),
    connectorId: z.number().int().nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
  }),
);

export const HeartbeatRow = add(
  'HeartbeatRow',
  z.object({
    receivedAt: IsoTime,
    version: z.string().nullable(),
    uptimeS: z.number().int().nullable(),
    publicIp: z.string().nullable(),
    lanIp: z.string().nullable(),
  }),
);

// ------------------------------------------------------------------------------ people --

export const RoleAssignmentSchema = add(
  'RoleAssignment',
  z.object({
    role: Role,
    resellerId: Uuid.nullable(),
    customerId: Uuid.nullable(),
    siteId: Uuid.nullable(),
  }),
);
export const RoleAssignmentInput = add(
  'RoleAssignmentWrite',
  z.object({
    role: Role,
    resellerId: Uuid.nullable().optional(),
    customerId: Uuid.nullable().optional(),
    siteId: Uuid.nullable().optional(),
  }),
);

export const Locale = add('Locale', z.enum(['pt-BR', 'en']));
export const User = add(
  'User',
  z.object({
    id: Uuid,
    email: z.string(),
    name: z.string(),
    locale: Locale,
    disabled: z.boolean(),
    roles: z.array(RoleAssignmentSchema),
    createdAt: IsoTime,
  }),
);
export const Me = add('Me', z.object({ user: User, permissions: z.array(Permission) }));

export const AuditEntry = add(
  'AuditEntry',
  z.object({
    id: z.number().int(),
    at: IsoTime,
    actorType: z.enum(['user', 'device', 'system']),
    actorId: z.string().nullable(),
    actorLabel: z.string().nullable(),
    action: z.string(),
    entityType: z.string(),
    entityId: z.string().nullable(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    ip: z.string().nullable(),
  }),
);

export const Ok = add('Ok', z.object({ ok: z.literal(true) }));
export const IdParams = z.object({ id: Uuid.describe('The id') });
export const limitQuery = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def).describe(`At most this many (default ${def}, at most ${max})`);
