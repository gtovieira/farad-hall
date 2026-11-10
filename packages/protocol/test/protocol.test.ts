import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptedVersions,
  CLAIM_CODE_ALPHABET,
  canonicalString,
  ENROL_KEY_ID,
  formatClaimCode,
  generateClaimCode,
  generateDeviceKeys,
  importPublicKey,
  isWellFormedClaimCode,
  newNonce,
  normalizeClaimCode,
  parseMessage,
  privateKeyFromSeed,
  protocolFiles,
  rawPublicKey,
  readSignatureHeaders,
  signRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  testVectors,
  timestampFresh,
  v1,
  verifySignature,
  type SignedParts,
} from '../src/index.js';

const root = join(import.meta.dirname, '..', '..', '..');

const heartbeat = { protocolVersion: 1, sentAt: '2026-11-10T14:00:00.000Z', version: 'v1.4.0', uptimeS: 5123, lanIp: '192.168.1.20' };
const state: v1.DeviceState = {
  protocolVersion: 1,
  sentAt: '2026-11-10T14:00:00.000Z',
  health: { ok: true, services: [{ name: 'control-engine', ok: true, status: 'healthy', restarts: 0 }] },
  resources: { cpuPct: 12.5, memPct: 40, diskPct: 31, temperatureC: 52.1 },
  control: { mode: 'normal', mainMeterOnline: true, invariant: 'ok' },
  chargers: [{ chargerId: 'cp-01', online: true, connectors: [{ connectorId: 1, status: 'Charging' }] }],
};

describe('messages', () => {
  it('accepts valid v1 messages and ignores unknown fields', () => {
    const r = parseMessage('heartbeat', { ...heartbeat, futureField: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBe(1);
      expect(r.message.uptimeS).toBe(5123);
      expect('futureField' in r.message).toBe(false);
    }
    expect(parseMessage('state', state).ok).toBe(true);
    expect(
      parseMessage('events', {
        protocolVersion: 1,
        events: [{ id: 'e1', timestamp: '2026-11-10T14:00:00Z', source: 'control-engine', kind: 'fallback-entered', severity: 'critical', message: 'meter lost' }],
      }).ok,
    ).toBe(true);
  });

  it('refuses a protocol version it does not accept, before validating', () => {
    for (const protocolVersion of [0, 2, '1', undefined]) {
      const r = parseMessage('heartbeat', { ...heartbeat, protocolVersion });
      expect(r).toMatchObject({ ok: false, reason: 'unsupported-protocol', supported: [1] });
    }
    expect(parseMessage('heartbeat', null)).toMatchObject({ ok: false, reason: 'unsupported-protocol' });
  });

  it('reports each invalid field with its path', () => {
    const r = parseMessage('state', { ...state, resources: { ...state.resources, cpuPct: 140 }, control: { mode: 'chaos', mainMeterOnline: true } });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'invalid') {
      const paths = r.issues.map((i) => i.path);
      expect(paths).toContain('resources.cpuPct');
      expect(paths).toContain('control.mode');
    }
  });

  it('refuses info events, empty batches, bad IPs and bad keys', () => {
    const ev = { id: 'e1', timestamp: '2026-11-10T14:00:00Z', source: 's', kind: 'k', message: 'm' };
    expect(v1.EventBatch.safeParse({ protocolVersion: 1, events: [{ ...ev, severity: 'info' }] }).success).toBe(false);
    expect(v1.EventBatch.safeParse({ protocolVersion: 1, events: [] }).success).toBe(false);
    expect(v1.Heartbeat.safeParse({ ...heartbeat, lanIp: '300.1.1.1' }).success).toBe(false);
    expect(v1.Heartbeat.safeParse({ ...heartbeat, lanIp: 'fe80::1' }).success).toBe(true);
    expect(v1.PublicKey.safeParse('abc').success).toBe(false);
  });

  it('accepts the current version and the one before', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([1]);
    expect(acceptedVersions(3, [1, 2, 3])).toEqual([2, 3]);
    expect(acceptedVersions(2, [1, 2])).toEqual([1, 2]);
    expect(acceptedVersions(1, [1])).toEqual([1]);
    // A v2 Hall still parses v1 messages: the version list is the only switch.
    expect(parseMessage('heartbeat', heartbeat, [1, 2]).ok).toBe(true);
  });
});

describe('signatures', () => {
  const keys = generateDeviceKeys();
  const parts = (over: Partial<SignedParts> = {}): SignedParts => ({
    method: 'POST',
    path: '/api/device/heartbeat',
    timestamp: 1762783200,
    nonce: newNonce(),
    keyId: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b',
    body: JSON.stringify(heartbeat),
    ...over,
  });

  it('verifies a good signature', () => {
    const p = parts();
    const h = readSignatureHeaders(signRequest(keys.privateKey, p));
    expect(h.ok).toBe(true);
    if (h.ok) {
      expect(h.deviceId).toBe(p.keyId);
      expect(verifySignature(importPublicKey(keys.publicKey), p, h.signature)).toBe(true);
    }
  });

  it('refuses any change to what was signed, and another key', () => {
    const p = parts();
    const h = readSignatureHeaders(signRequest(keys.privateKey, p));
    if (!h.ok) throw new Error('headers');
    const pub = importPublicKey(keys.publicKey);
    expect(verifySignature(pub, { ...p, body: p.body + ' ' }, h.signature)).toBe(false);
    expect(verifySignature(pub, { ...p, path: '/api/device/state' }, h.signature)).toBe(false);
    expect(verifySignature(pub, { ...p, method: 'PUT' }, h.signature)).toBe(false);
    expect(verifySignature(pub, { ...p, timestamp: p.timestamp + 1 }, h.signature)).toBe(false);
    expect(verifySignature(pub, { ...p, nonce: newNonce() }, h.signature)).toBe(false);
    expect(verifySignature(pub, { ...p, keyId: 'someone-else' }, h.signature)).toBe(false);
    expect(verifySignature(importPublicKey(generateDeviceKeys().publicKey), p, h.signature)).toBe(false);
    expect(verifySignature(pub, p, Buffer.alloc(64))).toBe(false);
  });

  it('checks the headers', () => {
    expect(readSignatureHeaders({}).ok).toBe(false);
    const good = signRequest(keys.privateKey, parts());
    expect(readSignatureHeaders({ ...good, 'hall-timestamp': '2026-11-10' }).ok).toBe(false);
    expect(readSignatureHeaders({ ...good, 'hall-nonce': 'short' }).ok).toBe(false);
    expect(readSignatureHeaders({ ...good, 'hall-signature': 'abc' }).ok).toBe(false);
    expect(readSignatureHeaders({ ...good, 'hall-nonce': ['a', 'b'] }).ok).toBe(false);
    // The enrolment request has no device header.
    const enrol = signRequest(keys.privateKey, parts({ keyId: ENROL_KEY_ID }));
    expect(enrol['hall-device']).toBeUndefined();
  });

  it('accepts timestamps within the window only', () => {
    expect(timestampFresh(1000, 1000)).toBe(true);
    expect(timestampFresh(1000 - 300, 1000)).toBe(true);
    expect(timestampFresh(1000 - 301, 1000)).toBe(false);
    expect(timestampFresh(1000 + 301, 1000)).toBe(false);
  });

  it('round-trips raw public keys and refuses wrong lengths', () => {
    expect(rawPublicKey(importPublicKey(keys.publicKey))).toBe(keys.publicKey);
    expect(rawPublicKey(keys.privateKey)).toBe(keys.publicKey);
    expect(() => importPublicKey('AAAA')).toThrow();
  });

  it('matches the committed test vectors (RFC 8032 key)', () => {
    const vectors = testVectors();
    // RFC 8032 §7.1 test 1: the public key of this seed.
    expect(Buffer.from(vectors.publicKey, 'base64url').toString('hex')).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const key = privateKeyFromSeed(Buffer.from(vectors.privateKeySeedHex, 'hex'));
    for (const c of vectors.cases) {
      expect(canonicalString(c)).toBe(c.canonicalString);
      expect(signRequest(key, c)['hall-signature']).toBe(c.headers['hall-signature']);
      expect(verifySignature(importPublicKey(vectors.publicKey), c, Buffer.from(c.headers['hall-signature']!, 'base64url'))).toBe(true);
    }
  });
});

describe('claim codes', () => {
  it('generates well-formed codes without look-alikes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = generateClaimCode();
      expect(isWellFormedClaimCode(c)).toBe(true);
      seen.add(c);
    }
    expect(seen.size).toBe(500);
    for (const c of '01OIL') expect(CLAIM_CODE_ALPHABET).not.toContain(c);
  });

  it('normalizes what a person types', () => {
    expect(normalizeClaimCode(' k7qm-4tzp ')).toBe('K7QM4TZP');
    expect(formatClaimCode('K7QM4TZP')).toBe('K7QM-4TZP');
    expect(isWellFormedClaimCode('K7QM4TZ')).toBe(false);
    expect(isWellFormedClaimCode('K7QM4TZ0')).toBe(false);
  });
});

describe('generated files', () => {
  it('protocol/v1 is current (pnpm --filter @hall/protocol generate)', () => {
    for (const [rel, text] of Object.entries(protocolFiles())) {
      expect(readFileSync(join(root, rel), 'utf8'), rel).toBe(text);
    }
  });

  it('describes every message and the signature scheme', () => {
    const doc = JSON.parse(readFileSync(join(root, 'protocol/v1/openapi.json'), 'utf8'));
    expect(Object.keys(doc.paths).sort()).toEqual(['/api/device/enrol', '/api/device/events', '/api/device/heartbeat', '/api/device/state']);
    expect(doc.components.securitySchemes.hallSignature.name).toBe('Hall-Signature');
    expect(doc.paths['/api/device/heartbeat'].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/Heartbeat');
    expect(doc['x-hall-supported-versions']).toEqual([1]);
  });
});
