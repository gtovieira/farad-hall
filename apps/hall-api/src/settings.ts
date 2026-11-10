// Settings people change in Hall (stored as JSON by key), with their defaults from the environment.
import { z } from 'zod';
import type { Config } from './config.js';
import type { Db, Queryable } from './db.js';

export const AlertSettings = z.object({
  offlineAfterMin: z.number().int().min(1).max(1440).describe('Open a device-offline alert after this many minutes without a message'),
  emailEnabled: z.boolean().describe('Send alerts by e-mail'),
  recipients: z.array(z.email()).max(50).describe('Who gets the alert e-mails'),
  notifyResolved: z.boolean().describe('Also send an e-mail when an alert closes by itself'),
});
export type AlertSettings = z.infer<typeof AlertSettings>;

export function defaultAlertSettings(config: Config): AlertSettings {
  return {
    offlineAfterMin: config.alerts.offlineAfterMin,
    emailEnabled: config.alerts.recipients.length > 0,
    recipients: config.alerts.recipients,
    notifyResolved: true,
  };
}

export async function getAlertSettings(db: Db, config: Config, on?: Queryable): Promise<AlertSettings> {
  const row = await db.one<{ value: unknown }>("SELECT value FROM settings WHERE key = 'alerts'", [], on);
  const stored = AlertSettings.partial().safeParse(row?.value ?? {});
  return { ...defaultAlertSettings(config), ...(stored.success ? stored.data : {}) };
}

export async function putAlertSettings(db: Db, value: AlertSettings, userId: string, on: Queryable): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('alerts', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(value), userId],
    on,
  );
}
