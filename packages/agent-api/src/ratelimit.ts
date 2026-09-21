/**
 * Rate-limit middleware stub (spec: agent-readable API). Fixed-window
 * counting in process memory, keyed by a caller-supplied identifier (the
 * verified agent key's org id). Deterministic: callers pass `now`. The
 * RateLimitEvent table exists for durable recording — the stub deliberately
 * stays pure so tests need no database; a production limiter would swap
 * this for a shared store without changing the route contract.
 */

export interface RateLimitConfig {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** Default agent-API budget: 60 requests per org per minute (stub). */
export const AGENT_RATE_LIMIT: RateLimitConfig = { limit: 60, windowMs: 60_000 };

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Epoch ms when the current window resets (Retry-After anchor). */
  resetAt: number;
}

const counters = new Map<string, { windowStart: number; count: number }>();

/** Bounded memory: drop every window that has fully elapsed before counting. */
function prune(now: number): void {
  for (const [key, entry] of counters) {
    if (now - entry.windowStart >= 60_000) {
      counters.delete(key);
    }
  }
}

export function checkRateLimit(
  identifier: string,
  now: Date,
  config: RateLimitConfig = AGENT_RATE_LIMIT,
): RateLimitDecision {
  const stamp = now.getTime();
  prune(stamp);
  const existing = counters.get(identifier);
  const windowStart = existing && stamp - existing.windowStart < config.windowMs ? existing.windowStart : stamp;
  const count = existing && windowStart === existing.windowStart ? existing.count : 0;
  const allowed = count < config.limit;
  counters.set(identifier, { windowStart, count: allowed ? count + 1 : count });
  return { allowed, remaining: Math.max(0, config.limit - (allowed ? count + 1 : count)), resetAt: windowStart + config.windowMs };
}

/** 429 response with a Retry-After header derived from the decision. */
export function rateLimitResponse(decision: RateLimitDecision): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
  return Response.json(
    { error: "rate limit exceeded", resetAt: new Date(decision.resetAt).toISOString() },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/** Test isolation — clear all counters. */
export function resetRateLimits(): void {
  counters.clear();
}
