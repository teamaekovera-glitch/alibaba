import { createHash } from "node:crypto";

/**
 * Org-scoped mock API keys (spec: agent-readable API). Deterministic and
 * derived from the org id — no external credential service, no secrets in
 * the database. The key embeds the org id in the clear plus a short
 * deterministic check value, so a key can be verified statelessly and the
 * bearer org extracted: agent APIs are strictly org-scoped and cross-org
 * data is withheld at the loader layer.
 *
 * MOCK-ONLY: this is not a production secret scheme — real deployments
 * would store hashed keys with rotation. The spec pins the mock-first,
 * deterministic contract.
 */

const KEY_PREFIX = "pak_";
const CHECK_PREFIX = "agent-key-v1";
const CHECK_LENGTH = 8;

export interface AgentKeyParts {
  orgId: string;
}

/** Deterministic org API key, stable for the lifetime of the org id. */
export function agentKeyForOrg(orgId: string): string {
  return `${KEY_PREFIX}${orgId}_${checkValue(orgId)}`;
}

function checkValue(orgId: string): string {
  return createHash("sha256").update(`${CHECK_PREFIX}:${orgId}`).digest("hex").slice(0, CHECK_LENGTH);
}

/**
 * Verify a bearer token and return the org it grants access to.
 * Returns null for malformed, tampered, or foreign keys — never throws.
 */
export function verifyAgentKey(key: string | null | undefined): AgentKeyParts | null {
  if (!key?.startsWith(KEY_PREFIX)) {
    return null;
  }
  const rest = key.slice(KEY_PREFIX.length);
  const separator = rest.lastIndexOf("_");
  if (separator <= 0) {
    return null;
  }
  const orgId = rest.slice(0, separator);
  const check = rest.slice(separator + 1);
  if (check !== checkValue(orgId)) {
    return null;
  }
  return { orgId };
}

/** Parse a Bearer authorization header into the key, or null. */
export function bearerKey(authorization: string | null | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const key = authorization.slice("Bearer ".length).trim();
  return key.length > 0 ? key : null;
}
