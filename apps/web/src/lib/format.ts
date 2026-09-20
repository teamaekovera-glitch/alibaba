/**
 * Pure display formatters for storefront money/quantity/time values. Money is
 * always integer cents in this codebase; these helpers are the only place a
 * cents value becomes a user-facing string.
 */

/** "$1.23" from integer cents (unit prices can be sub-dollar). */
export function formatPriceCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "1,250 units" from a raw quantity. */
export function formatQuantity(qty: number): string {
  return `${qty.toLocaleString("en-US")} units`;
}

/** "12 days" from a production-day count. */
export function formatLeadTimeDays(days: number): string {
  return `${days} days`;
}

/** "83%" from a 0..1 cosine similarity (visual search). */
export function formatSimilarity(similarity: number): string {
  return `${Math.round(similarity * 100)}%`;
}

/** Tier → badge label. Kept beside the badge component's colors. */
export function verificationLabel(tier: string): string {
  switch (tier) {
    case "AEKOVERA_VETTED":
      return "Aekovera-vetted";
    case "VERIFIED":
      return "Verified";
    default:
      return "Unverified";
  }
}
