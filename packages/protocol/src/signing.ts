// Request signatures (protocol/v1/README.md, "Signing a request").
//
// Every device request carries an Ed25519 signature over its method, path, timestamp, nonce, the
// SHA-256 of its body and the device id. The private key is generated on the device and never
// leaves it; Hall keeps the public key it was given at enrolment.
//
//   HALL-ED25519-V1\n<METHOD>\n<path?query>\n<timestamp>\n<nonce>\n<sha256(body) hex>\n<device id | "enrol">
//
// Headers: Hall-Device (absent on enrolment), Hall-Timestamp (unix seconds), Hall-Nonce (16–128
// characters of A–Z a–z 0–9 _ -, unique per request), Hall-Signature (the 64-byte signature,
// base64url without padding). Hall refuses a timestamp more than MAX_CLOCK_SKEW_S away from its
// clock, and a nonce it has already seen from that device within twice that window.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

export const SIGNATURE_SCHEME = 'HALL-ED25519-V1';
export const MAX_CLOCK_SKEW_S = 300;
/** How long Hall remembers a nonce: longer than any timestamp it accepts. */
export const NONCE_TTL_S = 2 * MAX_CLOCK_SKEW_S;
export const ENROL_KEY_ID = 'enrol';

export const HEADERS = {
  device: 'hall-device',
  timestamp: 'hall-timestamp',
  nonce: 'hall-nonce',
  signature: 'hall-signature',
} as const;

export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export interface SignedParts {
  method: string;
  /** The request target as sent: path and query string, e.g. /api/device/heartbeat. */
  path: string;
  /** Unix seconds. */
  timestamp: number;
  nonce: string;
  body: Uint8Array | string;
  /** The device id Hall gave at enrolment, or ENROL_KEY_ID on the enrolment request. */
  keyId: string;
}

export const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** The exact bytes that are signed. */
export function canonicalString(p: SignedParts): string {
  return [SIGNATURE_SCHEME, p.method.toUpperCase(), p.path, String(p.timestamp), p.nonce, sha256Hex(p.body), p.keyId].join('\n');
}

export const toBase64Url = (buf: Uint8Array) => Buffer.from(buf).toString('base64url');
export const fromBase64Url = (s: string) => Buffer.from(s, 'base64url');

/** A fresh nonce: 128 random bits, base64url (22 characters). */
export const newNonce = () => toBase64Url(randomBytes(16));

// ------------------------------------------------------------------------------ keys --

export interface DeviceKeys {
  privateKey: KeyObject;
  /** base64url of the 32 raw bytes (the JWK "x"): what the device presents at enrolment. */
  publicKey: string;
}

export function generateDeviceKeys(): DeviceKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: rawPublicKey(publicKey) };
}

/** The public key's 32 raw bytes, base64url. */
export function rawPublicKey(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('not an Ed25519 key');
  return jwk.x;
}

/** A KeyObject from the 32 raw bytes, base64url. Throws on anything else. */
export function importPublicKey(raw: string): KeyObject {
  if (fromBase64Url(raw).length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A private key from its 32-byte seed (test vectors, a key kept as raw bytes). */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** PEM (PKCS#8) of a private key, to keep on the device's disk. */
export const exportPrivateKeyPem = (key: KeyObject) => key.export({ format: 'pem', type: 'pkcs8' }).toString();
export const importPrivateKeyPem = (pem: string) => createPrivateKey(pem);

// ------------------------------------------------------------------- sign and verify --

/** The signature headers of a request (lower-case names). */
export function signRequest(privateKey: KeyObject, parts: SignedParts): Record<string, string> {
  const signature = toBase64Url(sign(null, Buffer.from(canonicalString(parts)), privateKey));
  const headers: Record<string, string> = {
    [HEADERS.timestamp]: String(parts.timestamp),
    [HEADERS.nonce]: parts.nonce,
    [HEADERS.signature]: signature,
  };
  if (parts.keyId !== ENROL_KEY_ID) headers[HEADERS.device] = parts.keyId;
  return headers;
}

export type SignatureHeaders =
  | { ok: true; deviceId: string | undefined; timestamp: number; nonce: string; signature: Buffer }
  | { ok: false; message: string };

/** Reads the signature headers (lower-case names, as Node gives them). */
export function readSignatureHeaders(headers: Record<string, string | string[] | undefined>): SignatureHeaders {
  const one = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? undefined : v;
  };
  const ts = one(HEADERS.timestamp);
  const nonce = one(HEADERS.nonce);
  const sig = one(HEADERS.signature);
  const device = one(HEADERS.device);
  if (!ts || !nonce || !sig) return { ok: false, message: 'missing Hall-Timestamp, Hall-Nonce or Hall-Signature' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, message: 'Hall-Timestamp must be unix seconds' };
  if (!NONCE_PATTERN.test(nonce)) return { ok: false, message: 'Hall-Nonce must be 16 to 128 characters of A-Z a-z 0-9 _ -' };
  if (!SIGNATURE_PATTERN.test(sig)) return { ok: false, message: 'Hall-Signature must be 64 bytes, base64url without padding' };
  return { ok: true, deviceId: device, timestamp: Number(ts), nonce, signature: fromBase64Url(sig) };
}

/** Whether `signature` is the key's signature of these parts. */
export function verifySignature(publicKey: KeyObject, parts: SignedParts, signature: Uint8Array): boolean {
  try {
    return verify(null, Buffer.from(canonicalString(parts)), publicKey, signature);
  } catch {
    return false;
  }
}

/** Whether a timestamp is within the accepted window of `nowS`. */
export const timestampFresh = (timestamp: number, nowS: number, skewS = MAX_CLOCK_SKEW_S) => Math.abs(nowS - timestamp) <= skewS;
