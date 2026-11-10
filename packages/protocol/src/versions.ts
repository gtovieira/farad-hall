// Protocol versions: which Hall accepts, and how a message of an older one becomes the current one.
//
// The fleet never updates at once, so Hall accepts at least the two latest versions. Every message
// carries `protocolVersion`; Hall reads it first, validates the body with that version's schema,
// then upgrades it to the current version's shape, so the rest of Hall only knows the current one.
// Adding version 2: write src/v2.ts, add it to MESSAGES with an upgrade from 1, and generate
// protocol/v2/. Version 1 stays until a version 3 exists.
import type { z } from 'zod';
import * as v1 from './v1.js';

export const CURRENT_PROTOCOL_VERSION = 1;

/** The kinds of message a device sends. */
export type MessageKind = 'enrol' | 'heartbeat' | 'state' | 'events';

/** The current version's message types: what Hall works with after upgrading. */
export interface CurrentMessages {
  enrol: v1.EnrolRequest;
  heartbeat: v1.Heartbeat;
  state: v1.DeviceState;
  events: v1.EventBatch;
}

interface VersionEntry {
  schemas: { [K in MessageKind]: z.ZodType };
  /** This version's message (validated) → the current version's. */
  upgrade: { [K in MessageKind]: (m: never) => CurrentMessages[K] };
}

const identity = <T>(m: T): T => m;

const MESSAGES: Record<number, VersionEntry> = {
  1: {
    schemas: { enrol: v1.EnrolRequest, heartbeat: v1.Heartbeat, state: v1.DeviceState, events: v1.EventBatch },
    upgrade: { enrol: identity, heartbeat: identity, state: identity, events: identity },
  },
};

/** The versions Hall accepts: the current one and the one before it (when it exists). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = acceptedVersions(CURRENT_PROTOCOL_VERSION, Object.keys(MESSAGES).map(Number));

/** The policy: the current version and the one before, among those that have schemas. */
export function acceptedVersions(current: number, known: readonly number[]): number[] {
  return [current, current - 1].filter((v) => known.includes(v)).sort((a, b) => a - b);
}

export type ParseResult<K extends MessageKind> =
  | { ok: true; version: number; message: CurrentMessages[K] }
  | { ok: false; reason: 'unsupported-protocol'; version: unknown; supported: readonly number[] }
  | { ok: false; reason: 'invalid'; version: number; issues: { path: string; message: string }[] };

/** The `protocolVersion` of a message body, before anything else is checked. */
export function versionOf(body: unknown): unknown {
  return body && typeof body === 'object' ? (body as { protocolVersion?: unknown }).protocolVersion : undefined;
}

/** Validates a device message in its own version and upgrades it to the current one. */
export function parseMessage<K extends MessageKind>(kind: K, body: unknown, supported: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS): ParseResult<K> {
  const version = versionOf(body);
  const entry = typeof version === 'number' && supported.includes(version) ? MESSAGES[version] : undefined;
  if (!entry) return { ok: false, reason: 'unsupported-protocol', version, supported };
  const parsed = entry.schemas[kind].safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid',
      version: version as number,
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    };
  }
  const upgrade = entry.upgrade[kind] as (m: unknown) => CurrentMessages[K];
  return { ok: true, version: version as number, message: upgrade(parsed.data) };
}
