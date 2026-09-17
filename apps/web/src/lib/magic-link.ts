import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless magic-link tokens: HMAC-SHA256 over a base64url JSON payload,
 * carrying the email and a short expiry. No token table needed — the signed
 * token IS the state. `secret` comes from AUTH_SECRET (a dev default keeps
 * local and e2e flows zero-config; production must set a real secret).
 */

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export function authSecret(): string {
  if (process.env.AUTH_SECRET) {
    return process.env.AUTH_SECRET;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set in production");
  }
  return "packsource-dev-secret-do-not-use-in-prod";
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function createMagicToken(email: string, now = new Date()): string {
  const payload = Buffer.from(
    JSON.stringify({ email: email.toLowerCase(), exp: now.getTime() + MAGIC_LINK_TTL_MS, jti: randomBytes(8).toString("base64url") }),
  ).toString("base64url");
  return `${payload}.${sign(payload, authSecret())}`;
}

export function verifyMagicToken(token: string, now = new Date()): { email: string } | null {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) {
    return null;
  }
  const expected = Buffer.from(sign(payloadB64, authSecret()));
  const actual = Buffer.from(signature);
  try {
    if (!timingSafeEqual(actual, expected)) {
      return null;
    }
  } catch {
    return null; // length mismatch → invalid
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as {
      email?: string;
      exp?: number;
    };
    if (!payload.email || typeof payload.exp !== "number" || payload.exp < now.getTime()) {
      return null;
    }
    return { email: payload.email };
  } catch {
    return null;
  }
}
