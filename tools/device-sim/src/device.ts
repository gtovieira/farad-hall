// A simulated Orquestra hall-agent. It does what the real one will: generate its Ed25519 key,
// enrol with a claim code, then sign and send heartbeats, state and events (protocol/v1). It keeps
// a clock offset from Hall's answers (so a device with a wrong clock still gets in) and can be told
// to misbehave (fallback, critical events, a stale clock, a replayed nonce) for tests and demos.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CURRENT_PROTOCOL_VERSION,
  DEVICE_PATHS,
  ENROL_KEY_ID,
  exportPrivateKeyPem,
  generateDeviceKeys,
  importPrivateKeyPem,
  newNonce,
  rawPublicKey,
  signRequest,
  type DeviceKeys,
  type v1,
} from '@hall/protocol';

/** Hall's answer: the message's answer on a 2xx, a DeviceError otherwise. */
export interface Answer<T = Record<string, unknown>> {
  status: number;
  body: T & Partial<v1.DeviceError>;
}

export interface SimProfile {
  hostname: string;
  version: string;
  apiVersion: string;
  imageDigest: string;
  lanIp: string;
  model: string;
  serial: string;
  siteName: string | undefined;
  chargers: number;
  controlMode: v1.ControlMode;
  /** Sent as X-Forwarded-For: the address a reverse proxy in front of Hall would report (demo). */
  forwardedFor?: string;
}

export interface SendOptions {
  /** Sign with this timestamp (unix s) instead of the corrected clock. */
  timestamp?: number;
  nonce?: string;
  /** Sign this body but send another (a tampered request). */
  sendBody?: string;
  /** Sign as another key id. */
  keyId?: string;
  /** Do not retry once after a stale-timestamp answer. */
  noClockRetry?: boolean;
}

const SERVICES = ['portal', 'control-engine', 'modbus-svc', 'ocpp-server', 'history-svc', 'billing-svc', 'journal-svc', 'redis', 'postgres'];

let simCount = 0;

export class SimDevice {
  readonly keys: DeviceKeys;
  deviceId: string | undefined;
  readonly profile: SimProfile;
  /** Seconds to add to the local clock (learnt from Hall), and a deliberate skew (tests). */
  clockOffsetS = 0;
  skewS = 0;
  readonly bootAt = Date.now() - 3600_000 * (1 + Math.random() * 48);
  lastNonce: string | undefined;
  private cpu = 8 + Math.random() * 10;
  private connectorStates: v1.ConnectorStatus[];

  constructor(
    readonly baseUrl: string,
    opts: { keys?: DeviceKeys; deviceId?: string; profile?: Partial<SimProfile> } = {},
  ) {
    this.keys = opts.keys ?? generateDeviceKeys();
    this.deviceId = opts.deviceId;
    const n = ++simCount;
    this.profile = {
      hostname: `orquestra-${String(n).padStart(2, '0')}`,
      version: 'v1.4.0',
      apiVersion: '1.1.0',
      imageDigest: `sha256:${'a1b2c3d4'.repeat(8)}`,
      lanIp: `192.168.10.${20 + n}`,
      model: 'Raspberry Pi 5 Model B Rev 1.0',
      serial: `10000000${(0xabc000 + n).toString(16)}`,
      siteName: undefined,
      chargers: 4,
      controlMode: 'normal',
      ...opts.profile,
    };
    this.connectorStates = Array.from({ length: this.profile.chargers }, (_, i) => (i % 3 === 0 ? 'Charging' : i % 3 === 1 ? 'Available' : 'SuspendedEV'));
  }

  // ------------------------------------------------------------------------ identity --

  /** The identity on disk: the private key (PEM) and the device id. */
  save(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ privateKeyPem: exportPrivateKeyPem(this.keys.privateKey), deviceId: this.deviceId, profile: this.profile }, null, 2), { mode: 0o600 });
  }

  static load(baseUrl: string, file: string): SimDevice {
    const s = JSON.parse(readFileSync(file, 'utf8')) as { privateKeyPem: string; deviceId?: string; profile?: Partial<SimProfile> };
    const privateKey = importPrivateKeyPem(s.privateKeyPem);
    return new SimDevice(baseUrl, { keys: { privateKey, publicKey: rawPublicKey(privateKey) }, deviceId: s.deviceId, profile: s.profile });
  }

  // ------------------------------------------------------------------------- sending --

  nowS(): number {
    return Math.floor(Date.now() / 1000) + this.clockOffsetS + this.skewS;
  }

  /** A signed POST of `body` to `path`. */
  async send<T = Record<string, unknown>>(path: string, body: unknown, opts: SendOptions = {}): Promise<Answer<T>> {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const keyId = opts.keyId ?? (path === DEVICE_PATHS.enrol ? ENROL_KEY_ID : this.deviceId);
    if (!keyId) throw new Error('not enrolled: call enrol() first');
    const nonce = opts.nonce ?? newNonce();
    this.lastNonce = nonce;
    const headers = signRequest(this.keys.privateKey, { method: 'POST', path, timestamp: opts.timestamp ?? this.nowS(), nonce, body: text, keyId });
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `hall-device-sim/${this.profile.version}`,
        ...(this.profile.forwardedFor ? { 'x-forwarded-for': this.profile.forwardedFor } : {}),
        ...headers,
      },
      body: opts.sendBody ?? text,
    });
    const answer: Answer<T> = { status: res.status, body: (await res.json().catch(() => null)) as T & Partial<v1.DeviceError> };
    const b = answer.body as { error?: string; serverTime?: string; receivedAt?: string } | null;
    // Keep the clock offset from Hall's own time.
    const serverTime = b?.receivedAt ?? b?.serverTime;
    if (serverTime) this.clockOffsetS = Math.round((Date.parse(serverTime) - Date.now()) / 1000) - this.skewS;
    if (res.status === 401 && b?.error === 'stale-timestamp' && !opts.noClockRetry && opts.timestamp === undefined) {
      return this.send<T>(path, body, { ...opts, noClockRetry: true, nonce: undefined });
    }
    return answer;
  }

  async enrol(claimCode: string): Promise<Answer<v1.EnrolResponse>> {
    const p = this.profile;
    const req: v1.EnrolRequest = {
      protocolVersion: CURRENT_PROTOCOL_VERSION as 1,
      claimCode,
      publicKey: this.keys.publicKey,
      device: {
        orquestraVersion: p.version,
        apiVersion: p.apiVersion,
        imageDigest: p.imageDigest,
        hostname: p.hostname,
        serial: p.serial,
        model: p.model,
        ...(p.siteName ? { siteName: p.siteName } : {}),
      },
    };
    const a = await this.send<v1.EnrolResponse>(DEVICE_PATHS.enrol, req);
    if (a.status === 201) this.deviceId = a.body.deviceId;
    return a;
  }

  heartbeatMessage(): v1.Heartbeat {
    const p = this.profile;
    return {
      protocolVersion: 1,
      sentAt: new Date((this.nowS() - this.skewS) * 1000).toISOString(),
      version: p.version,
      uptimeS: Math.floor((Date.now() - this.bootAt) / 1000),
      lanIp: p.lanIp,
      imageDigest: p.imageDigest,
      apiVersion: p.apiVersion,
    };
  }

  heartbeat(opts?: SendOptions): Promise<Answer<v1.Ack>> {
    return this.send<v1.Ack>(DEVICE_PATHS.heartbeat, this.heartbeatMessage(), opts);
  }

  stateMessage(over: Partial<v1.DeviceState> = {}): v1.DeviceState {
    this.cpu = Math.min(95, Math.max(3, this.cpu + (Math.random() - 0.5) * 6));
    // Now and then a connector changes.
    if (Math.random() < 0.3) {
      const i = Math.floor(Math.random() * this.connectorStates.length);
      const cycle: v1.ConnectorStatus[] = ['Available', 'Preparing', 'Charging', 'SuspendedEV', 'Finishing'];
      this.connectorStates[i] = cycle[(cycle.indexOf(this.connectorStates[i]!) + 1) % cycle.length]!;
    }
    const mode = this.profile.controlMode;
    return {
      protocolVersion: 1,
      sentAt: new Date().toISOString(),
      health: { ok: true, services: SERVICES.map((name) => ({ name, ok: true, status: 'healthy', restarts: 0 })) },
      resources: {
        cpuPct: Math.round(this.cpu * 10) / 10,
        memPct: Math.round((38 + Math.random() * 6) * 10) / 10,
        memTotalMb: 4096,
        diskPct: 31.4,
        diskFreeGb: 74.2,
        temperatureC: Math.round((48 + this.cpu / 4 + Math.random() * 2) * 10) / 10,
        loadAvg1: Math.round(this.cpu * 4) / 100,
        watchdogResets: 0,
      },
      control: {
        mode,
        mainMeterOnline: mode !== 'fallback-analyzer',
        invariant: mode === 'normal' ? 'ok' : 'unverified',
        activeSessions: this.connectorStates.filter((s) => s === 'Charging').length,
        pausedSessions: this.connectorStates.filter((s) => s === 'SuspendedEVSE').length,
      },
      chargers: this.connectorStates.map((status, i) => ({
        chargerId: `cp-${String(i + 1).padStart(2, '0')}`,
        online: true,
        vendor: 'WEG',
        model: 'WEMOB-A-22',
        firmware: '2.3.1',
        connectors: [{ connectorId: 1, status }],
      })),
      ...over,
    };
  }

  state(over?: Partial<v1.DeviceState>, opts?: SendOptions): Promise<Answer<v1.Ack>> {
    return this.send<v1.Ack>(DEVICE_PATHS.state, this.stateMessage(over), opts);
  }

  static event(over: Partial<v1.DeviceEvent> = {}): v1.DeviceEvent {
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: 'control-engine',
      kind: 'analyzer-lost',
      severity: 'critical',
      message: 'main-inlet meter lost: every charger at the 6 A floor',
      ...over,
    };
  }

  events(events: v1.DeviceEvent[], opts?: SendOptions): Promise<Answer<v1.Ack>> {
    return this.send<v1.Ack>(DEVICE_PATHS.events, { protocolVersion: 1, events }, opts);
  }

  // ---------------------------------------------------------------------------- loop --

  /**
   * Runs like an agent: a heartbeat every heartbeatS, the state every stateS and at once when the
   * control mode changes. Resolves when `signal` aborts. Errors are reported, not thrown.
   */
  async run(o: { heartbeatS: number; stateS: number; signal: AbortSignal; onAnswer?: (what: string, a: Answer) => void; onError?: (err: Error) => void }): Promise<void> {
    let lastState = 0;
    let lastMode = this.profile.controlMode;
    while (!o.signal.aborted) {
      try {
        // Sent first: `o.onAnswer?.(…, await …)` would skip the request when there is no onAnswer.
        const hb = await this.heartbeat();
        o.onAnswer?.('heartbeat', hb);
        if (Date.now() - lastState >= o.stateS * 1000 || lastMode !== this.profile.controlMode) {
          const st = await this.state();
          o.onAnswer?.('state', st);
          lastState = Date.now();
          lastMode = this.profile.controlMode;
        }
      } catch (err) {
        o.onError?.(err as Error);
      }
      if (o.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          o.signal.removeEventListener('abort', done);
          resolve();
        };
        const t = setTimeout(done, o.heartbeatS * 1000);
        o.signal.addEventListener('abort', done, { once: true });
      });
    }
  }
}
