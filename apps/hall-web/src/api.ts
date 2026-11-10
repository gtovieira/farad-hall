// The Hall API, from the browser: JSON, the session cookie, errors as ApiError. The types mirror
// docs/api/openapi.json (the parts the screens read).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Called on a 401: the session ended. */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized();
    throw new ApiError(res.status, String(json['error'] ?? 'error'), String(json['message'] ?? res.statusText), json);
  }
  return json as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export interface Ref {
  id: string;
  name: string;
}
export type Presence = 'online' | 'offline' | 'revoked';
export type ControlMode = 'normal' | 'fallback-analyzer' | 'fallback-error' | 'no-settings';
export type SiteKind = 'condominio' | 'eletroposto' | 'empresa' | 'estacionamento';

export interface User {
  id: string;
  email: string;
  name: string;
  locale: 'pt-BR' | 'en';
  roles: { role: string; resellerId: string | null; customerId: string | null; siteId: string | null }[];
}
export interface Me {
  user: User;
  permissions: string[];
}

export interface FleetDevice {
  id: string;
  name: string;
  status: 'active' | 'revoked';
  presence: Presence;
  lastSeenAt: string | null;
  version: string | null;
  protocolVersion: number | null;
  publicIp: string | null;
  lanIp: string | null;
  uptimeS: number | null;
  imageDigest: string | null;
  controlMode: ControlMode | null;
  healthOk: boolean | null;
  site: Ref;
  customer: Ref;
  reseller: Ref | null;
  openAlerts: number;
  criticalAlerts: number;
  enrolledAt: string;
}
export interface Fleet {
  generatedAt: string;
  onlineWindowS: number;
  summary: { total: number; online: number; offline: number; revoked: number; withAlerts: number; openAlerts: number };
  devices: FleetDevice[];
}

export interface Alert {
  id: string;
  rule: 'device-offline' | 'control-fallback' | 'critical-event';
  severity: 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'closed';
  title: string;
  details: Record<string, unknown>;
  occurrences: number;
  openedAt: string;
  lastOccurredAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  ackNote: string | null;
  closedAt: string | null;
  closeNote: string | null;
  device: Ref;
  site: Ref;
  customer: Ref;
}

export interface DeviceState {
  sentAt: string;
  health: { ok: boolean; services: { name: string; ok: boolean; status?: string; restarts?: number }[] };
  resources: { cpuPct: number; memPct: number; diskPct: number; diskFreeGb?: number; temperatureC: number | null };
  control: { mode: ControlMode; mainMeterOnline: boolean; invariant?: string; activeSessions?: number };
  chargers: { chargerId: string; online: boolean; vendor?: string; model?: string; connectors: { connectorId: number; status: string | null; errorCode?: string }[] }[];
}

export interface DeviceDetail extends FleetDevice {
  hostname: string | null;
  serial: string | null;
  model: string | null;
  apiVersion: string | null;
  publicKey: string;
  enrolledIp: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  lastHeartbeatAt: string | null;
  lastStateAt: string | null;
  lastState: DeviceState | null;
  alerts: Alert[];
}

export interface DevicePresence {
  from: string;
  to: string;
  bucketS: number;
  expectedPerBucket: number;
  buckets: { start: string; heartbeats: number }[];
}

export interface DeviceEventRow {
  id: number;
  occurredAt: string;
  severity: 'warning' | 'critical';
  kind: string;
  source: string;
  message: string;
  chargerId: string | null;
}

export interface Address {
  street?: string | null;
  number?: string | null;
  city?: string | null;
  state?: string | null;
}
export interface Customer {
  id: string;
  reseller: Ref | null;
  legalName: string;
  tradeName: string | null;
  documentType: 'cnpj' | 'cpf';
  document: string;
  address: Address;
  contacts: { name: string; email?: string | null; phone?: string | null }[];
  siteCount: number;
  deviceCount: number;
}
export interface Reseller {
  id: string;
  name: string;
}
export interface Site {
  id: string;
  customer: Ref;
  reseller: Ref | null;
  name: string;
  kind: SiteKind;
  address: Address;
  utility: string | null;
  deviceCount: number;
}
export interface ClaimCode {
  id: string;
  site: Ref;
  customer: Ref;
  label: string | null;
  hint: string;
  status: 'active' | 'used' | 'expired' | 'revoked';
  createdAt: string;
  createdBy: string | null;
  expiresAt: string;
  usedAt: string | null;
  device: Ref | null;
  code?: string;
}
