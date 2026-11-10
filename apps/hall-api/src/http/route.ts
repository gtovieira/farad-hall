// Routes that document themselves: each one carries the zod schemas it validates its input with
// and the ones its answers follow, so src/openapi.ts writes the contract from the same objects.
import type { OperationDoc, ResponseDoc } from '@hall/openapi';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '../auth/rbac.js';
import type { AuthedDevice, Deps, SessionUser } from '../context.js';
import { ErrorBody, HttpError, invalid } from './errors.js';

/**
 * Who may call a route: anyone; a signed device; a device enrolling (signed with the key it
 * presents: the handler checks it); a signed-in person (with a permission).
 */
export type Auth = 'public' | 'device' | 'enrol' | 'session' | { perm: Permission };

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface Ctx<P, Q, B> {
  params: Out<P>;
  query: Out<Q>;
  body: Out<B>;
  req: FastifyRequest;
  reply: FastifyReply;
  deps: Deps;
  /** The signed-in person (session routes). */
  user: SessionUser;
  /** The signed device (device routes). */
  device: AuthedDevice;
}

export interface RouteSpec<P extends z.ZodObject | undefined = undefined, Q extends z.ZodObject | undefined = undefined, B extends z.ZodType | undefined = undefined> {
  method: OperationDoc['method'];
  path: string;
  summary: string;
  description?: string;
  /** Default: the method and the path in camelCase. */
  operationId?: string;
  tag: string;
  auth: Auth;
  params?: P;
  query?: Q;
  body?: B;
  /** The body as documented, when the handler validates it itself (device messages: version first). */
  docBody?: z.ZodType;
  headers?: OperationDoc['headers'];
  /** Answers: status → schema or ResponseDoc (2xx). */
  responses: Record<number, z.ZodType | ResponseDoc | null>;
  /** Error statuses it answers besides the common ones (400, 401/403 by its auth, 422 with input). */
  errors?: number[];
  handler: (ctx: Ctx<P, Q, B>) => Promise<unknown>;
}

// The concrete types are checked where each route is written (defineRoute); the list holds any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteSpec<any, any, any>;

export function defineRoute<P extends z.ZodObject | undefined = undefined, Q extends z.ZodObject | undefined = undefined, B extends z.ZodType | undefined = undefined>(
  spec: RouteSpec<P, Q, B>,
): AnyRoute {
  return spec as AnyRoute;
}

const isZod = (v: unknown): v is z.ZodType => v instanceof z.ZodType;

function responseDoc(v: z.ZodType | ResponseDoc | null, status: number): ResponseDoc {
  if (v === null) return { description: status === 204 ? 'Done, no body' : 'No body' };
  if (isZod(v)) return { description: 'OK', schema: v };
  return v;
}

const ERROR_TEXT: Record<number, string> = {
  400: 'Not JSON, or not a valid request',
  401: 'Not signed in (unauthorized)',
  403: 'Signed in, but not allowed (forbidden)',
  404: 'Not found',
  409: 'Conflicts with what exists (conflict), or still in use (in-use)',
  410: 'Gone',
  413: 'Body too large',
  422: 'Invalid input (invalid): issues per field',
  429: 'Too many attempts (locked-out), retryAfterS',
};

/** The route as an OpenAPI operation. */
export function operationOf(r: AnyRoute): OperationDoc {
  const responses: Record<number, ResponseDoc> = {};
  for (const [status, v] of Object.entries(r.responses)) responses[Number(status)] = responseDoc(v, Number(status));
  const errors = new Set(r.errors ?? []);
  errors.add(400);
  if (r.auth !== 'public') errors.add(401);
  if (r.auth === 'device') errors.add(403);
  if (typeof r.auth === 'object') errors.add(403);
  if (r.body || r.query || r.params) errors.add(422);
  for (const s of errors) if (!responses[s]) responses[s] = { description: ERROR_TEXT[s] ?? 'Error', schema: ErrorBody };
  return {
    method: r.method,
    path: r.path,
    summary: r.summary,
    ...(r.operationId ? { operationId: r.operationId } : {}),
    ...(r.description ? { description: r.description } : {}),
    tags: [r.tag],
    security: r.auth === 'public' ? [] : r.auth === 'device' || r.auth === 'enrol' ? ['hallSignature'] : ['session'],
    ...(r.params ? { params: r.params } : {}),
    ...(r.query ? { query: r.query } : {}),
    ...(r.headers ? { headers: r.headers } : {}),
    ...(r.body || r.docBody ? { body: (r.body ?? r.docBody)! } : {}),
    responses,
    ...(typeof r.auth === 'object' ? { extensions: { 'x-hall-permission': r.auth.perm } } : {}),
  };
}

export interface Authenticators {
  session: (req: FastifyRequest) => Promise<SessionUser>;
  device: (req: FastifyRequest) => Promise<AuthedDevice>;
  permit: (user: SessionUser, perm: Permission) => void;
}

/** Registers the routes on Fastify. */
export function registerRoutes(app: FastifyInstance, routes: readonly AnyRoute[], deps: Deps, auth: Authenticators): void {
  for (const r of routes) {
    const okStatus = Object.keys(r.responses).map(Number).filter((s) => s < 300).sort((a, b) => a - b)[0] ?? 200;
    app.route({
      method: r.method,
      url: r.path,
      handler: async (req, reply) => {
        if (r.auth === 'device') req.device = await auth.device(req);
        else if (r.auth !== 'public' && r.auth !== 'enrol') {
          req.user = await auth.session(req);
          if (typeof r.auth === 'object') auth.permit(req.user, r.auth.perm);
        }
        const parse = (schema: z.ZodType | undefined, value: unknown, what: string) => {
          if (!schema) return undefined;
          const res = schema.safeParse(value ?? {});
          if (!res.success) throw invalid(what, res.error);
          return res.data;
        };
        const ctx = {
          params: parse(r.params, req.params, 'path'),
          query: parse(r.query, req.query, 'query'),
          body: parse(r.body, req.body, 'body'),
          req,
          reply,
          deps,
          get user(): SessionUser {
            if (!req.user) throw new HttpError(401, 'unauthorized', 'sign in');
            return req.user;
          },
          get device(): AuthedDevice {
            if (!req.device) throw new HttpError(401, 'unauthorized', 'device not authenticated');
            return req.device;
          },
        };
        const result = await r.handler(ctx as Ctx<undefined, undefined, undefined>);
        if (reply.sent) return reply;
        const status = reply.statusCode !== 200 ? reply.statusCode : okStatus;
        const doc = r.responses[status];
        if (deps.validateResponses && doc) {
          const schema = isZod(doc) ? doc : doc.schema;
          if (schema) {
            const check = schema.safeParse(result);
            if (!check.success) throw new Error(`${r.method} ${r.path} answered ${status} off its contract: ${JSON.stringify(check.error.issues.slice(0, 5))}`);
          }
        }
        if (result === undefined) return reply.code(status).send();
        return reply.code(status).send(result);
      },
    });
  }
}
