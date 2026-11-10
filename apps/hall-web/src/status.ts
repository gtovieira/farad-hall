// How a state reads: its tone (colour) and its label key.
import type { Alert, ClaimCode, ControlMode, Presence } from './api.js';
import type { Key } from './i18n.js';
import type { Tone } from './ui.js';

export const presenceTone: Record<Presence, Tone> = { online: 'ok', offline: 'off', revoked: 'err' };
export const presenceKey = (p: Presence) => `presence.${p}` as Key;
export const modeTone = (m: ControlMode | null): Tone => (m === 'normal' ? 'ok' : m === 'no-settings' ? 'warn' : m ? 'err' : 'off');
export const modeKey = (m: ControlMode) => `mode.${m}` as Key;
export const severityTone = (s: Alert['severity']): Tone => (s === 'critical' ? 'err' : 'warn');
export const codeTone: Record<ClaimCode['status'], Tone> = { active: 'volt', used: 'ok', expired: 'off', revoked: 'err' };
/** OCPP connector states: available green, charging volt, faulted red, the rest grey or amber. */
export function connectorTone(status: string | null): Tone {
  if (status === 'Available') return 'ok';
  if (status === 'Charging') return 'volt';
  if (status === 'Faulted') return 'err';
  if (status === 'SuspendedEV' || status === 'SuspendedEVSE' || status === 'Preparing' || status === 'Finishing') return 'warn';
  return 'off';
}
