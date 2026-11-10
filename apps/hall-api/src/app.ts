// The Hall API as a Fastify app: every route, the error shape, the session cookie, the raw body for
// device signatures, and (optionally) the web UI's files.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { AlertEngine } from './alerts/engine.js';
import { mailerFor, type Mailer } from './alerts/mail.js';
import { audit, SYSTEM } from './audit.js';
import { hashPassword } from './auth/passwords.js';
import { permit } from './auth/rbac.js';
import { sessionAuthenticator } from './auth/sessions.js';
import type { Config } from './config.js';
import type { Deps } from './context.js';
import { Db, migrate } from './db.js';
import { deviceAuthenticator } from './device/auth.js';
import { deviceRoutes } from './device/ingest.js';
import { installErrorHandler } from './http/errors.js';
import { registerRoutes, type AnyRoute } from './http/route.js';
import { startJobs } from './jobs.js';
import { apiDocument } from './openapi.js';
import { adminRoutes } from './routes/admin.js';
import { alertRoutes } from './routes/alerts.js';
import { authRoutes } from './routes/auth.js';
import { claimCodeRoutes } from './routes/claim-codes.js';
import { fleetRoutes } from './routes/devices.js';
import { orgRoutes } from './routes/org.js';
import { userRoutes } from './routes/users.js';

/** Request bodies: 1 MiB (an event batch of 500 fits). */
export const BODY_LIMIT = 1024 * 1024;

export interface BuildOptions {
  config: Config;
  db?: Db;
  mailer?: Mailer;
  now?: () => Date;
  validateResponses?: boolean;
  logger?: boolean;
}

export interface Hall {
  app: FastifyInstance;
  deps: Deps;
  routes: AnyRoute[];
  /** Starts the background jobs (offline check, pruning); returns their stop. */
  startJobs(): () => void;
  close(): Promise<void>;
}

/** Every route of the API (without Fastify: the contract is written from this list). */
export function allRoutes(openapi: () => Record<string, unknown>): AnyRoute[] {
  return [...adminRoutes(openapi), ...authRoutes(), ...userRoutes(), ...orgRoutes(), ...claimCodeRoutes(), ...fleetRoutes(), ...alertRoutes(), ...deviceRoutes()];
}

const trustHops = (hops: number) => (_addr: string, i: number) => i < hops;

let docCache: Record<string, unknown> | undefined;
/** The contract, written once per process. */
export function contract(): Record<string, unknown> {
  return (docCache ??= apiDocument(allRoutes(contract)));
}

export async function buildHall(opts: BuildOptions): Promise<Hall> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger === false || config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers["hall-signature"]'] },
    // A hop count is a function for Fastify's types (it is what proxy-addr does with a number).
    trustProxy: typeof config.trustProxy === 'number' ? trustHops(config.trustProxy) : config.trustProxy,
    bodyLimit: BODY_LIMIT,
    // Long enough for a slow 4G link; the agent retries.
    requestTimeout: 30_000,
  });
  const db = opts.db ?? new Db(config.databaseUrl);
  const log = {
    info: (o: object, m: string) => app.log.info(o, m),
    error: (o: object, m: string) => app.log.error(o, m),
  };
  const mailer = opts.mailer ?? mailerFor(config, (m, data) => app.log.info(data, m));
  const now = opts.now ?? (() => new Date());
  const alerts = new AlertEngine({ db, config, mailer, now, log });
  const deps: Deps = { db, config, now, mailer, alerts, validateResponses: opts.validateResponses ?? false };

  // JSON bodies are kept as bytes too: a device signature covers the exact body.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      const err = new Error('the body is not valid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  await app.register(cookie);
  installErrorHandler(app);

  const routes = allRoutes(contract);
  registerRoutes(app, routes, deps, { session: sessionAuthenticator(deps), device: deviceAuthenticator(deps), permit });

  if (config.webDir && existsSync(join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, index: ['index.html'] });
    // Client-side routes: any GET outside /api that is not a file is the app.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'not-found', message: `${req.method} ${req.url} not found` });
    });
  }

  if (config.migrate) await migrate(db);
  if (config.admin) await bootstrapAdmin(deps, config.admin.email, config.admin.password);

  return {
    app,
    deps,
    routes,
    startJobs: () => startJobs(deps, log),
    close: async () => {
      await app.close();
      await alerts.idle();
      if (!opts.db) await db.close();
    },
  };
}

/** The first admin-farad, from HALL_ADMIN_EMAIL / HALL_ADMIN_PASSWORD, when nobody exists yet. */
export async function bootstrapAdmin(deps: Deps, email: string, password: string): Promise<boolean> {
  const any = await deps.db.one('SELECT 1 FROM users LIMIT 1');
  if (any) return false;
  const hash = await hashPassword(password);
  await deps.db.tx(async (tx) => {
    const u = await deps.db.one<{ id: string }>("INSERT INTO users (email, name, password_hash) VALUES ($1, 'Admin Farad', $2) RETURNING id", [email, hash], tx);
    await deps.db.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, 'admin-farad')", [u!.id], tx);
    await audit(deps.db, tx, SYSTEM, { action: 'user.bootstrap-admin', entityType: 'user', entityId: u!.id, after: { email } });
  });
  return true;
}
