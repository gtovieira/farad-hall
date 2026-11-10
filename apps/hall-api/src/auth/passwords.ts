// Passwords: scrypt (node:crypto, no native module), N = 2^15, r = 8, p = 1, 16-byte salt,
// 32-byte key, stored as scrypt$N$r$p$salt$key (base64url). Verification takes the parameters
// from the stored hash, so they can be raised later without breaking existing passwords.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const maxmem = (n: number, r: number) => 256 * n * r;

export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, 'base64url');
  const want = Buffer.from(parts[5]!, 'base64url');
  if (!(n > 1 && r > 0 && p > 0) || want.length === 0) return false;
  const got = await scrypt(password.normalize('NFKC'), salt, want.length, { N: n, r, p, maxmem: maxmem(n, r) });
  return timingSafeEqual(got, want);
}

/** A hash to compare against when the user does not exist, so both paths take the same time. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword('not-a-password-at-all'));
