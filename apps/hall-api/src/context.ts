// What every route handler can reach.
import type { AlertEngine } from './alerts/engine.js';
import type { Mailer } from './alerts/mail.js';
import type { Role } from './auth/rbac.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

export interface Deps {
  db: Db;
  config: Config;
  /** The clock (tests move it). */
  now: () => Date;
  mailer: Mailer;
  alerts: AlertEngine;
  /** Check every answer against its documented schema (tests). */
  validateResponses: boolean;
}

export interface RoleAssignment {
  role: Role;
  resellerId: string | null;
  customerId: string | null;
  siteId: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  locale: 'pt-BR' | 'en';
  roles: RoleAssignment[];
}

export interface AuthedDevice {
  id: string;
  siteId: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    user?: SessionUser;
    sessionTokenHash?: Buffer;
    device?: AuthedDevice;
  }
}
