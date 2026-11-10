// Every 4xx and 5xx answer is JSON of one shape: { error, message, hint?, issues?, ... }.
import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';

export const ErrorCode = z.enum([
  'bad-request',
  'invalid',
  'unauthorized',
  'forbidden',
  'not-found',
  'conflict',
  'in-use',
  'invalid-credentials',
  'locked-out',
  'payload-too-large',
  'internal',
]);

export const ErrorBody = z.object({
  error: z.string().describe('A machine code (ErrorCode for the people API, DeviceErrorCode for devices); the set may grow'),
  message: z.string(),
  hint: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  retryAfterS: z.number().int().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not-found', `${what} not found`);
export const forbidden = (message = 'you may not do this') => new HttpError(403, 'forbidden', message);
export const conflict = (message: string, hint?: string) => new HttpError(409, 'conflict', message, hint ? { hint } : {});

export function issuesOf(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

export const invalid = (what: string, err: z.ZodError) =>
  new HttpError(422, 'invalid', `Invalid ${what}: ${issuesOf(err).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`, {
    issues: issuesOf(err),
  });

/** Postgres errors the API turns into answers: unique (409), foreign key or restrict (409 in-use), check (422) violations. */
function fromPg(err: { code?: string; constraint?: string; table?: string }): HttpError | undefined {
  if (err.code === '23505') return new HttpError(409, 'conflict', `already exists (${err.constraint ?? 'unique'})`);
  // 23503 foreign_key_violation; 23001 restrict_violation (ON DELETE RESTRICT from Postgres 18 on).
  if (err.code === '23503' || err.code === '23001') return new HttpError(409, 'in-use', `still referenced (${err.constraint ?? 'foreign key'})`, { hint: 'remove what refers to it first' });
  if (err.code === '23514') return new HttpError(422, 'invalid', `refused by a check (${err.constraint ?? 'check'})`);
  return undefined;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError & { code?: string }, req, reply) => {
    let e: HttpError | undefined;
    if (error instanceof HttpError) e = error;
    else if (error instanceof z.ZodError) e = invalid('request', error);
    else if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new HttpError(413, 'payload-too-large', 'the body is too large');
    else if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') e = new HttpError(415, 'bad-request', 'send application/json');
    else if (error.statusCode && error.statusCode < 500) e = new HttpError(error.statusCode, 'bad-request', error.message);
    else e = fromPg(error as never);
    if (!e) {
      req.log.error({ err: error }, 'request failed');
      e = new HttpError(500, 'internal', 'internal error');
    }
    const body: Record<string, unknown> = { error: e.code, message: e.message, ...e.extra };
    void reply.code(e.status).send(body);
  });
}

/**
 * Unknown paths: a JSON 404. With the web UI, a GET outside /api that names no file (no extension:
 * /devices/…) is the app, for its client-side routes; a missing file stays a 404.
 */
export function installNotFound(app: FastifyInstance, spa: boolean): void {
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    if (spa && req.method === 'GET' && !path.startsWith('/api/') && !/\.[A-Za-z0-9]+$/.test(path)) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'not-found', message: `${req.method} ${req.url} not found` });
  });
}
