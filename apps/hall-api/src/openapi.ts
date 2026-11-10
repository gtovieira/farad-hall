// The people API and the device API as one OpenAPI 3.1 document (docs/api/openapi.json, and
// GET /api/openapi.json), from the routes and their zod schemas.
import { buildOpenApi } from '@hall/openapi';
import { CURRENT_PROTOCOL_VERSION, SIGNATURE_SECURITY_SCHEME } from '@hall/protocol';
import { SESSION_COOKIE } from './auth/sessions.js';
import { operationOf, type AnyRoute } from './http/route.js';
import { apiNames } from './schemas.js';

/** The API's version (semver): what a client checks. */
export const API_VERSION = '1.0.0';

export const TAGS = [
  { name: 'meta', description: 'Hall itself: health, this contract' },
  { name: 'auth', description: 'Signing in (session cookie), the signed-in person' },
  { name: 'users', description: 'People and their roles (admin-farad)' },
  { name: 'org', description: 'Resellers › customers › sites' },
  { name: 'devices', description: 'The fleet, each device, claim codes' },
  { name: 'alerts', description: 'Alerts: list, acknowledge, close' },
  { name: 'audit', description: 'The audit log' },
  { name: 'settings', description: 'Settings changed in Hall' },
  { name: 'device', description: `The Hall protocol v${CURRENT_PROTOCOL_VERSION}: what an Orquestra sends (protocol/v1)` },
];

export function apiDocument(routes: readonly AnyRoute[]): Record<string, unknown> {
  return buildOpenApi({
    info: {
      title: 'Farad Hall API',
      version: API_VERSION,
      description:
        'The central that manages every Farad Orquestra. People sign in with a session cookie; devices sign every request ' +
        `with their Ed25519 key (the Hall protocol v${CURRENT_PROTOCOL_VERSION}, protocol/v1).`,
    },
    tags: TAGS,
    securitySchemes: {
      session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE, description: 'Set by POST /api/auth/login (httpOnly, SameSite=Strict)' },
      hallSignature: SIGNATURE_SECURITY_SCHEME,
    },
    operations: routes.map(operationOf),
    names: apiNames,
    extensions: { 'x-hall-protocol-version': CURRENT_PROTOCOL_VERSION },
  });
}

export const API_CONTRACT_FILE = 'docs/api/openapi.json';
