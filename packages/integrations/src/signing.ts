import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing — HMAC-SHA256 over `<timestamp>.<body>`, the format used by
 * Stripe and GitHub so OS consumers can reuse their verification tooling.
 * Verification compares digests with a timing-safe equality check and enforces
 * a replay window on the timestamp.
 */

export const SIGNATURE_HEADER = "x-packsource-signature";
export const SIGNATURE_TOLERANCE_SECONDS = 300; // ±5 minutes

export function signatureHeader(secret: string, timestampSeconds: number, body: string): string {
  const digest = signBody(secret, timestampSeconds, body);
  return `t=${timestampSeconds}, v1=${digest}`;
}

export function verifySignature(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): { ok: boolean; reason?: string } {
  const parsed = parseSignatureHeader(header);
  if (!parsed.ok) {
    return parsed;
  }
  const { timestampSeconds, digest } = parsed;
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return { ok: false, reason: "timestamp outside replay window" };
  }
  const expected = signBody(secret, timestampSeconds, body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(digest, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

function signBody(secret: string, timestampSeconds: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
}

function parseSignatureHeader(
  header: string,
): { ok: true; timestampSeconds: number; digest: string } | { ok: false; reason: string } {
  const parts = header.split(",").map((chunk) => chunk.trim());
  let timestampSeconds: number | undefined;
  let digest: string | undefined;
  for (const part of parts) {
    if (part.startsWith("t=")) {
      timestampSeconds = Number(part.slice(2));
    } else if (part.startsWith("v1=")) {
      digest = part.slice(3);
    }
  }
  if (timestampSeconds === undefined || !Number.isInteger(timestampSeconds)) {
    return { ok: false, reason: "malformed signature header: missing integer t=" };
  }
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, reason: "malformed signature header: missing hex v1=" };
  }
  return { ok: true, timestampSeconds, digest };
}
