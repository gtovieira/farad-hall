// Claim codes: an admin (or support, or a reseller for its own sites) creates one for a site; the
// installer types it into the Orquestra, whose hall-agent enrols with it (device/ingest.ts). The
// code is shown once: Hall keeps its SHA-256.
import { CLAIM_CODE_TTL_H, formatClaimCode, generateClaimCode, sha256Hex } from '@hall/protocol';
import { z } from 'zod';
import { actorOf, audit } from '../audit.js';
import { scopeOf, siteScopeSql } from '../auth/rbac.js';
import type { Deps, SessionUser } from '../context.js';
import type { Queryable } from '../db.js';
import { conflict, notFound } from '../http/errors.js';
import { defineRoute, type AnyRoute } from '../http/route.js';
import { ClaimCode, ClaimCodeCreated, ClaimCodeStatus, IdParams, Uuid } from '../schemas.js';
import { siteInScope } from './org.js';

type ClaimCodeView = z.infer<typeof ClaimCode>;

interface Row {
  id: string;
  site_id: string;
  site_name: string;
  customer_id: string;
  customer_name: string;
  label: string | null;
  code_hint: string;
  created_at: Date;
  created_by_email: string | null;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  device_id: string | null;
  device_name: string | null;
}

const statusOf = (r: Row, now: Date): z.infer<typeof ClaimCodeStatus> =>
  r.used_at ? 'used' : r.revoked_at ? 'revoked' : r.expires_at <= now ? 'expired' : 'active';

const view = (r: Row, now: Date): ClaimCodeView => ({
  id: r.id,
  site: { id: r.site_id, name: r.site_name },
  customer: { id: r.customer_id, name: r.customer_name },
  label: r.label,
  hint: `…${r.code_hint}`,
  status: statusOf(r, now),
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by_email,
  expiresAt: r.expires_at.toISOString(),
  usedAt: r.used_at?.toISOString() ?? null,
  device: r.device_id ? { id: r.device_id, name: r.device_name ?? '' } : null,
});

async function list(deps: Deps, user: SessionUser, filter: { id?: string; siteId?: string; status?: string }, on?: Queryable): Promise<ClaimCodeView[]> {
  const params: unknown[] = [];
  const where = [siteScopeSql(scopeOf(user, 'devices:manage')!, params)];
  if (filter.id) where.push(`cc.id = $${params.push(filter.id)}`);
  if (filter.siteId) where.push(`cc.site_id = $${params.push(filter.siteId)}`);
  const now = deps.now();
  const rows = await deps.db.query<Row>(
    `SELECT cc.*, s.name AS site_name, c.id AS customer_id, c.legal_name AS customer_name, u.email AS created_by_email, d.name AS device_name
       FROM claim_codes cc JOIN sites s ON s.id = cc.site_id JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = cc.created_by LEFT JOIN devices d ON d.id = cc.device_id
      WHERE ${where.join(' AND ')} ORDER BY cc.created_at DESC LIMIT 500`,
    params,
    on,
  );
  return rows.map((r) => view(r, now)).filter((v) => !filter.status || v.status === filter.status);
}

const CreateBody = z.object({
  siteId: Uuid,
  label: z.string().trim().max(200).optional().describe('A note, e.g. who installs it'),
});
const ListQuery = z.object({ siteId: Uuid.optional(), status: ClaimCodeStatus.optional() });

export function claimCodeRoutes(): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/api/claim-codes',
      tag: 'devices',
      summary: 'Claim codes in your scope (the newest 500)',
      auth: { perm: 'devices:manage' },
      query: ListQuery,
      responses: { 200: z.array(ClaimCode) },
      handler: ({ query, user, deps }) => list(deps, user, query),
    }),
    defineRoute({
      method: 'POST',
      path: '/api/claim-codes',
      tag: 'devices',
      summary: `Create a claim code for a site: single use, valid ${CLAIM_CODE_TTL_H} h, shown only in this answer`,
      auth: { perm: 'devices:manage' },
      body: CreateBody,
      responses: { 201: ClaimCodeCreated },
      errors: [404],
      handler: async ({ body, user, req, deps }) => {
        await siteInScope(deps, user, body.siteId, 'devices:manage');
        const code = generateClaimCode();
        const now = deps.now();
        return deps.db.tx(async (tx) => {
          const row = await deps.db.one<{ id: string }>(
            'INSERT INTO claim_codes (code_hash, code_hint, site_id, label, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [Buffer.from(sha256Hex(code), 'hex'), code.slice(-2), body.siteId, body.label || null, user.id, now, new Date(now.getTime() + CLAIM_CODE_TTL_H * 3600_000)],
            tx,
          );
          const v = (await list(deps, user, { id: row!.id }, tx))[0]!;
          await audit(deps.db, tx, actorOf(req), { action: 'claim-code.create', entityType: 'claim-code', entityId: v.id, after: { siteId: body.siteId, label: v.label, expiresAt: v.expiresAt } });
          return { ...v, code: formatClaimCode(code) };
        });
      },
    }),
    defineRoute({
      method: 'DELETE',
      path: '/api/claim-codes/:id',
      tag: 'devices',
      summary: 'Revoke a claim code not used yet',
      auth: { perm: 'devices:manage' },
      params: IdParams,
      responses: { 200: ClaimCode },
      errors: [404, 409],
      handler: async ({ params, user, req, deps }) => {
        return deps.db.tx(async (tx) => {
          const before = (await list(deps, user, { id: params.id }, tx))[0];
          if (!before) throw notFound('claim code');
          if (before.status === 'used') throw conflict('this claim code was used already', 'revoke the device instead');
          await deps.db.query('UPDATE claim_codes SET revoked_at = coalesce(revoked_at, $2) WHERE id = $1', [params.id, deps.now()], tx);
          const after = (await list(deps, user, { id: params.id }, tx))[0]!;
          await audit(deps.db, tx, actorOf(req), { action: 'claim-code.revoke', entityType: 'claim-code', entityId: params.id, before, after });
          return after;
        });
      },
    }),
  ];
}
