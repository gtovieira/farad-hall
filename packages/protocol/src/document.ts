// The Hall protocol as an OpenAPI 3.1 document and standalone JSON Schemas (protocol/v1/), for the
// Orquestra's hall-agent to vendor. src/generate.ts writes them; the tests check they are current.
import { buildOpenApi, SchemaNames, type OperationDoc, type ResponseDoc } from '@hall/openapi';
import type { z } from 'zod';
import { DEVICE_PATHS } from './paths.js';
import { HEADERS, MAX_CLOCK_SKEW_S, NONCE_TTL_S, SIGNATURE_SCHEME } from './signing.js';
import * as v1 from './v1.js';
import { CURRENT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './versions.js';

/** The named schemas of version 1 (components/schemas). */
export function protocolNames(): SchemaNames {
  const n = new SchemaNames();
  const add = (name: string, s: z.ZodType) => n.add(name, s);
  add('EnrolRequest', v1.EnrolRequest);
  add('EnrolResponse', v1.EnrolResponse);
  add('DeviceInfo', v1.DeviceInfo);
  add('Intervals', v1.Intervals);
  add('Heartbeat', v1.Heartbeat);
  add('DeviceState', v1.DeviceState);
  add('ServiceHealth', v1.ServiceHealth);
  add('Resources', v1.Resources);
  add('ControlMode', v1.ControlMode);
  add('ControlState', v1.ControlState);
  add('ChargerState', v1.ChargerState);
  add('ConnectorState', v1.ConnectorState);
  add('ConnectorStatus', v1.ConnectorStatus);
  add('EventBatch', v1.EventBatch);
  add('DeviceEvent', v1.DeviceEvent);
  add('EventSeverity', v1.EventSeverity);
  add('Ack', v1.Ack);
  add('DeviceError', v1.DeviceError);
  add('DeviceErrorCode', v1.DeviceErrorCode);
  add('IpAddress', v1.IpAddress);
  add('PublicKey', v1.PublicKey);
  add('ImageDigest', v1.ImageDigest);
  return n;
}

/** The standalone JSON Schema files: file name → schema. */
export const PROTOCOL_SCHEMA_FILES: Record<string, z.ZodType> = {
  'enrol-request.schema.json': v1.EnrolRequest,
  'enrol-response.schema.json': v1.EnrolResponse,
  'heartbeat.schema.json': v1.Heartbeat,
  'state.schema.json': v1.DeviceState,
  'events.schema.json': v1.EventBatch,
  'ack.schema.json': v1.Ack,
  'error.schema.json': v1.DeviceError,
};

const err = (description: string): ResponseDoc => ({ description, schema: v1.DeviceError });

const signatureHeaders = (enrol: boolean): OperationDoc['headers'] => ({
  ...(enrol
    ? {}
    : { 'Hall-Device': { description: 'The device id Hall gave at enrolment', required: true } }),
  'Hall-Timestamp': { description: `Unix seconds; within ${MAX_CLOCK_SKEW_S} s of Hall's clock`, required: true },
  'Hall-Nonce': { description: `Unique per request (16–128 of A–Z a–z 0–9 _ -); Hall refuses one seen within ${NONCE_TTL_S} s`, required: true },
  'Hall-Signature': { description: `Ed25519 signature (base64url, 64 bytes) of the ${SIGNATURE_SCHEME} canonical string`, required: true },
});

const common = {
  400: err('Not JSON'),
  401: err('Signature missing or wrong (unauthorized, bad-signature), stale timestamp (stale-timestamp, with serverTime), replayed nonce (replayed-nonce), unknown device (unknown-device)'),
  413: err('Body too large (1 MiB)'),
  422: err('Invalid message (invalid, with issues), or a protocol version Hall does not accept (unsupported-protocol, with supportedVersions)'),
};

const signedOp = (op: Omit<OperationDoc, 'tags' | 'headers' | 'method'>): OperationDoc => ({
  method: 'POST',
  tags: ['device'],
  headers: signatureHeaders(false),
  security: ['hallSignature'],
  ...op,
  responses: { ...op.responses, ...common, 403: err('The device is revoked (device-revoked): stop sending') },
});

export const PROTOCOL_OPERATIONS: OperationDoc[] = [
  {
    method: 'POST',
    path: DEVICE_PATHS.enrol,
    operationId: 'enrol',
    summary: 'Enrol: a claim code and a new public key become a device of a site',
    description:
      'The device generates its Ed25519 key pair, then sends the claim code an admin created in Hall with its public key, ' +
      `signed with that key (Hall-Device absent; the canonical string ends in "enrol"). A claim code is single use and lives 24 h.`,
    tags: ['device'],
    headers: signatureHeaders(true),
    security: ['hallSignature'],
    body: v1.EnrolRequest,
    responses: {
      201: { description: 'Enrolled: keep the deviceId', schema: v1.EnrolResponse },
      ...common,
      409: err('This public key is already enrolled (already-enrolled)'),
      410: err('The claim code expired (claim-code-expired) or was used (claim-code-used): ask for a new one'),
      404: err('No such claim code (claim-code-invalid)'),
      429: err('Too many failed attempts from this address (rate-limited)'),
    },
  },
  signedOp({ path: DEVICE_PATHS.heartbeat, operationId: 'heartbeat', summary: 'Presence: version, uptime, LAN IP, image', body: v1.Heartbeat, responses: { 200: { description: 'Stored', schema: v1.Ack } } }),
  signedOp({ path: DEVICE_PATHS.state, operationId: 'state', summary: 'Health, resources, control mode and chargers', body: v1.DeviceState, responses: { 200: { description: 'Stored', schema: v1.Ack } } }),
  signedOp({ path: DEVICE_PATHS.events, operationId: 'events', summary: 'Warning and critical events (idempotent by event id)', body: v1.EventBatch, responses: { 200: { description: 'Stored', schema: v1.Ack } } }),
];

export const SIGNATURE_SECURITY_SCHEME = {
  type: 'apiKey',
  in: 'header',
  name: 'Hall-Signature',
  description:
    `Ed25519 request signature (${SIGNATURE_SCHEME}). The device signs the UTF-8 bytes of\n\n` +
    `    ${SIGNATURE_SCHEME}\\n<METHOD>\\n<path and query>\\n<Hall-Timestamp>\\n<Hall-Nonce>\\n<lower-case hex SHA-256 of the body bytes>\\n<Hall-Device, or "enrol">\n\n` +
    'with the private key it generated, and sends the signature in Hall-Signature (base64url, no padding), with the ' +
    `${HEADERS.device}, ${HEADERS.timestamp} and ${HEADERS.nonce} headers. See protocol/v1/README.md and test-vectors.json.`,
};

export function protocolDocument(): Record<string, unknown> {
  return buildOpenApi({
    info: {
      title: 'Farad Hall protocol',
      version: `${CURRENT_PROTOCOL_VERSION}.0.0`,
      description:
        "The contract between Farad Hall and the Orquestra's hall-agent: enrolment, heartbeat, state and events, " +
        `each signed with the device's Ed25519 key. Messages carry protocolVersion; Hall accepts versions ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
    },
    tags: [{ name: 'device', description: 'Messages from an Orquestra to Hall' }],
    securitySchemes: { hallSignature: SIGNATURE_SECURITY_SCHEME },
    operations: PROTOCOL_OPERATIONS,
    names: protocolNames(),
    extensions: { 'x-hall-protocol-version': CURRENT_PROTOCOL_VERSION, 'x-hall-supported-versions': SUPPORTED_PROTOCOL_VERSIONS },
  });
}
