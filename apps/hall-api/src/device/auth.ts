// Device authentication: every request is signed with the device's Ed25519 key (protocol/v1/README.md).
// Checked in this order, so nothing is stored for a request that is not genuine: the headers, the
// timestamp window, the device, the signature, then the nonce (recorded only for a good signature).
import { importPublicKey, NONCE_TTL_S, readSignatureHeaders, timestampFresh, verifySignature, ENROL_KEY_ID, type SignedParts } from '@hall/protocol';
import type { FastifyRequest } from 'fastify';
import type { AuthedDevice, Deps } from '../context.js';
import { HttpError } from '../http/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signedParts(req: FastifyRequest, timestamp: number, nonce: string, keyId: string): SignedParts {
  return { method: req.method, path: req.url, timestamp, nonce, body: req.rawBody ?? Buffer.alloc(0), keyId };
}

function headersOrThrow(deps: Deps, req: FastifyRequest) {
  const h = readSignatureHeaders(req.headers);
  if (!h.ok) throw new HttpError(401, 'unauthorized', h.message, { hint: 'sign the request (protocol/v1/README.md)' });
  const now = deps.now();
  if (!timestampFresh(h.timestamp, Math.floor(now.getTime() / 1000))) {
    throw new HttpError(401, 'stale-timestamp', 'Hall-Timestamp is too far from the server clock', {
      serverTime: now.toISOString(),
      hint: 'correct the clock offset with serverTime and send again',
    });
  }
  return h;
}

/** Records the nonce; false when it was seen within its lifetime (a replay). */
async function useNonce(deps: Deps, keyId: string, nonce: string): Promise<boolean> {
  const now = deps.now();
  const row = await deps.db.one(
    `INSERT INTO device_nonces (key_id, nonce, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (key_id, nonce) DO UPDATE SET expires_at = EXCLUDED.expires_at WHERE device_nonces.expires_at < $4
     RETURNING 1 AS ok`,
    [keyId, nonce, new Date(now.getTime() + NONCE_TTL_S * 1000), now],
  );
  return row !== undefined;
}

export function deviceAuthenticator(deps: Deps) {
  return async (req: FastifyRequest): Promise<AuthedDevice> => {
    const h = headersOrThrow(deps, req);
    if (!h.deviceId || !UUID.test(h.deviceId)) throw new HttpError(401, 'unauthorized', 'Hall-Device must be the device id Hall gave at enrolment');
    const d = await deps.db.one<{ id: string; site_id: string; name: string; public_key: string; status: string }>(
      'SELECT id, site_id, name, public_key, status FROM devices WHERE id = $1',
      [h.deviceId],
    );
    if (!d) throw new HttpError(401, 'unknown-device', 'no such device', { hint: 'enrol again with a new claim code' });
    if (!verifySignature(importPublicKey(d.public_key), signedParts(req, h.timestamp, h.nonce, d.id), h.signature)) {
      throw new HttpError(401, 'bad-signature', 'the signature does not match');
    }
    if (d.status === 'revoked') throw new HttpError(403, 'device-revoked', 'this device was revoked in Hall', { hint: 'stop sending; enrol again only if an admin asks' });
    if (!(await useNonce(deps, d.id, h.nonce))) throw new HttpError(401, 'replayed-nonce', 'this nonce was already used', { hint: 'use a new nonce for every request' });
    return { id: d.id, siteId: d.site_id, name: d.name };
  };
}

/** The enrolment request is signed with the key it presents (proof that the device holds it). */
export async function verifyEnrolment(deps: Deps, req: FastifyRequest, publicKey: string): Promise<void> {
  const h = headersOrThrow(deps, req);
  let key;
  try {
    key = importPublicKey(publicKey);
  } catch {
    throw new HttpError(422, 'invalid', 'publicKey is not an Ed25519 public key');
  }
  if (!verifySignature(key, signedParts(req, h.timestamp, h.nonce, ENROL_KEY_ID), h.signature)) {
    throw new HttpError(401, 'bad-signature', 'the signature does not match the public key presented');
  }
  if (!(await useNonce(deps, `pk:${publicKey}`, h.nonce))) throw new HttpError(401, 'replayed-nonce', 'this nonce was already used');
}

/** The address a request came from, IPv4 without its IPv6 mapping. */
export const clientIp = (req: FastifyRequest) => req.ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
