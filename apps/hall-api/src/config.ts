// The API's configuration, from the environment (deploy/.env.example lists every key).
import { z } from 'zod';

const bool = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no'])
  .transform((v) => v === '1' || v === 'true' || v === 'yes');
const int = (def: number, min = 1, max = 1_000_000) => z.coerce.number().int().min(min).max(max).default(def);
const optional = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  HALL_HOST: z.string().default('0.0.0.0'),
  HALL_PORT: int(8080, 1, 65535),
  /** The address people open Hall at (links in e-mails), e.g. https://hall.farad.com.br */
  HALL_PUBLIC_URL: optional,
  /** Fastify trustProxy: hops (1 behind Caddy), a list of addresses/CIDRs, or false. */
  HALL_TRUST_PROXY: z.string().default('false'),
  HALL_COOKIE_SECURE: bool.default(true),
  HALL_SESSION_TTL_H: int(12, 1, 24 * 30),
  HALL_ADMIN_EMAIL: optional,
  HALL_ADMIN_PASSWORD: optional,
  HALL_WEB_DIR: optional,
  HALL_MIGRATE: bool.default(true),
  HALL_JOBS: bool.default(true),
  HALL_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HALL_HEARTBEAT_S: int(60, 10, 3600),
  HALL_STATE_S: int(300, 30, 3600),
  HALL_ALERT_OFFLINE_MIN: int(5, 1, 1440),
  HALL_ALERT_RECIPIENTS: optional,
  HALL_RETENTION_HEARTBEATS_DAYS: int(14),
  HALL_RETENTION_STATES_DAYS: int(30),
  HALL_RETENTION_EVENTS_DAYS: int(400),
  HALL_RETENTION_AUDIT_DAYS: int(1830),
  HALL_MAIL_TRANSPORT: z.enum(['smtp', 'log']).optional(),
  SMTP_HOST: optional,
  SMTP_PORT: int(587, 1, 65535),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: optional,
  SMTP_PASSWORD: optional,
  SMTP_FROM: z.string().default('Farad Hall <hall@localhost>'),
  HALL_VERSION: z.string().default('dev'),
});

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  publicUrl: string | undefined;
  trustProxy: boolean | number | string;
  cookieSecure: boolean;
  sessionTtlH: number;
  admin: { email: string; password: string } | undefined;
  webDir: string | undefined;
  migrate: boolean;
  jobs: boolean;
  logLevel: string;
  intervals: { heartbeatS: number; stateS: number };
  alerts: { offlineAfterMin: number; recipients: string[] };
  retentionDays: { heartbeats: number; states: number; events: number; audit: number };
  mail:
    | { transport: 'log' }
    | { transport: 'smtp'; host: string; port: number; secure: boolean; user: string | undefined; password: string | undefined; from: string };
  mailFrom: string;
  version: string;
}

function trustProxy(v: string): boolean | number | string {
  if (v === 'false' || v === '0' || v === '') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const transport = e.HALL_MAIL_TRANSPORT ?? (e.SMTP_HOST ? 'smtp' : 'log');
  if (transport === 'smtp' && !e.SMTP_HOST) throw new Error('invalid configuration: HALL_MAIL_TRANSPORT=smtp needs SMTP_HOST');
  if ((e.HALL_ADMIN_EMAIL && !e.HALL_ADMIN_PASSWORD) || (!e.HALL_ADMIN_EMAIL && e.HALL_ADMIN_PASSWORD)) {
    throw new Error('invalid configuration: set both HALL_ADMIN_EMAIL and HALL_ADMIN_PASSWORD, or neither');
  }
  return {
    databaseUrl: e.DATABASE_URL,
    host: e.HALL_HOST,
    port: e.HALL_PORT,
    publicUrl: e.HALL_PUBLIC_URL?.replace(/\/+$/, ''),
    trustProxy: trustProxy(e.HALL_TRUST_PROXY),
    cookieSecure: e.HALL_COOKIE_SECURE,
    sessionTtlH: e.HALL_SESSION_TTL_H,
    admin: e.HALL_ADMIN_EMAIL && e.HALL_ADMIN_PASSWORD ? { email: e.HALL_ADMIN_EMAIL, password: e.HALL_ADMIN_PASSWORD } : undefined,
    webDir: e.HALL_WEB_DIR,
    migrate: e.HALL_MIGRATE,
    jobs: e.HALL_JOBS,
    logLevel: e.HALL_LOG_LEVEL,
    intervals: { heartbeatS: e.HALL_HEARTBEAT_S, stateS: e.HALL_STATE_S },
    alerts: {
      offlineAfterMin: e.HALL_ALERT_OFFLINE_MIN,
      recipients: (e.HALL_ALERT_RECIPIENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    retentionDays: {
      heartbeats: e.HALL_RETENTION_HEARTBEATS_DAYS,
      states: e.HALL_RETENTION_STATES_DAYS,
      events: e.HALL_RETENTION_EVENTS_DAYS,
      audit: e.HALL_RETENTION_AUDIT_DAYS,
    },
    mail:
      transport === 'smtp'
        ? { transport, host: e.SMTP_HOST!, port: e.SMTP_PORT, secure: e.SMTP_SECURE, user: e.SMTP_USER, password: e.SMTP_PASSWORD, from: e.SMTP_FROM }
        : { transport: 'log' },
    mailFrom: e.SMTP_FROM,
    version: e.HALL_VERSION,
  };
}

/** A configuration for tests and the demo: the defaults, a database, overrides. */
export function testConfig(databaseUrl: string, over: Partial<Config> = {}): Config {
  return { ...loadConfig({ DATABASE_URL: databaseUrl, HALL_COOKIE_SECURE: '0', HALL_JOBS: '0', HALL_LOG_LEVEL: 'silent' }), ...over };
}
