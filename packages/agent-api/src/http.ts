import { bearerKey, verifyAgentKey, type AgentKeyParts } from "./keys";
import { checkRateLimit, rateLimitResponse, type RateLimitDecision } from "./ratelimit";

/**
 * Shared wiring for the agent API routes: bearer-key authentication, rate
 * limiting, and stable paging params. Route handlers stay thin; the
 * load-and-serialize logic lives behind these helpers.
 */

/** Default page size for agent list endpoints. */
export const AGENT_DEFAULT_PAGE_SIZE = 25;
/** Hard cap — agents asking for more get clamped, not rejected. */
export const AGENT_MAX_PAGE_SIZE = 100;

export type AgentAuthResult = { ok: true; orgId: string } | { ok: false; response: Response };

/**
 * Authenticate an agent request: `Authorization: Bearer <key>` must verify
 * to an org-scoped mock key. 401 with a stable error body otherwise.
 */
export function agentAuth(request: Request): AgentAuthResult {
  const key = bearerKey(request.headers.get("authorization"));
  const verified: AgentKeyParts | null = verifyAgentKey(key);
  if (!verified) {
    return {
      ok: false,
      response: Response.json(
        { error: "invalid or missing API key", docs: "request an org key via the Aekovera OS integration" },
        { status: 401 },
      ),
    };
  }
  return { ok: true, orgId: verified.orgId };
}

export type AgentRateLimitResult = { ok: true; decision: RateLimitDecision } | { ok: false; response: Response };

/** Enforce the agent rate budget for the authenticated org (stub limiter). */
export function agentRateLimit(orgId: string, now: Date): AgentRateLimitResult {
  const decision = checkRateLimit(`agent:${orgId}`, now);
  if (!decision.allowed) {
    return { ok: false, response: rateLimitResponse(decision) };
  }
  return { ok: true, decision };
}

export interface AgentPaging {
  limit: number;
  offset: number;
}

/** Parse `limit`/`offset` query params with defaults and clamping. */
export function parseAgentPaging(searchParams: URLSearchParams): AgentPaging {
  const rawLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const rawOffset = Number.parseInt(searchParams.get("offset") ?? "", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), AGENT_MAX_PAGE_SIZE) : AGENT_DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  return { limit, offset };
}

/** Stable success envelope for list endpoints. */
export function agentPage<T>(items: T[], paging: AgentPaging, total: number): Response {
  return Response.json({
    data: items,
    paging: { ...paging, total },
  });
}
