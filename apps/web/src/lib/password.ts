import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// promisify binds to the 3-argument scrypt overload; pin the 4-argument form.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing with node's built-in scrypt — no external dependency.
 * Stored form: `scrypt$N$<salt-b64>$<hash-b64>`; verification is
 * timing-safe. Hash and verify are pure async functions over strings.
 */

const KEY_LENGTH_BYTES = 64;
const SCRYPT_COST = 16384; // N — ~50ms on modern hardware

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, KEY_LENGTH_BYTES, { N: SCRYPT_COST })) as Buffer;
  return `scrypt$${SCRYPT_COST}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, costRaw, saltRaw, hashRaw] = stored.split("$");
  if (scheme !== "scrypt" || !costRaw || !saltRaw || !hashRaw) {
    return false;
  }
  const cost = Number(costRaw);
  const salt = Buffer.from(saltRaw, "base64");
  const expected = Buffer.from(hashRaw, "base64");
  const actual = (await scrypt(password, salt, expected.length, { N: cost })) as Buffer;
  try {
    return timingSafeEqual(actual, expected);
  } catch {
    // timingSafeEqual throws on length mismatch — that is a failed verify.
    return false;
  }
}
