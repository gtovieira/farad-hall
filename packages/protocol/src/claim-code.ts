// Claim codes: short, single-use, typed by a person. 8 characters from an alphabet without the
// look-alikes (0 O 1 I L U), shown as two groups: K7QM-4TZP. 30^8 ≈ 6.6 · 10^11 codes; Hall keeps
// only their hash, lets each live 24 h, and limits the failed attempts per address.
import { randomInt } from 'node:crypto';

export const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const CLAIM_CODE_LENGTH = 8;
export const CLAIM_CODE_TTL_H = 24;

/** A new code, normalized (no dash). */
export function generateClaimCode(): string {
  let s = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) s += CLAIM_CODE_ALPHABET[randomInt(CLAIM_CODE_ALPHABET.length)];
  return s;
}

/** Upper case, without dashes and spaces. */
export const normalizeClaimCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

/** Whether a normalized code can be one Hall made. */
export function isWellFormedClaimCode(normalized: string): boolean {
  if (normalized.length !== CLAIM_CODE_LENGTH) return false;
  for (const c of normalized) if (!CLAIM_CODE_ALPHABET.includes(c)) return false;
  return true;
}

/** K7QM4TZP → K7QM-4TZP */
export const formatClaimCode = (normalized: string) => `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
