import type { ListingSearchDocument, ListingSearchQuery } from "./types";

type Matched = { doc: ListingSearchDocument; score: number };

/** Deterministic ordering for every sort option; id ascending breaks ties. */
export function orderMatched(
  matched: Matched[],
  sort: ListingSearchQuery["sort"],
): Matched[] {
  const byId = (a: Matched, b: Matched) =>
    a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0;

  if (sort === "price-asc" || sort === "price-desc") {
    return matched.slice().sort((a, b) => {
      const aPrice = a.doc.priceCents;
      const bPrice = b.doc.priceCents;
      // Listings without a ladder sort last regardless of direction.
      if (aPrice == null || bPrice == null) {
        return aPrice == null && bPrice == null ? byId(a, b) : aPrice == null ? 1 : -1;
      }
      return sort === "price-asc" ? aPrice - bPrice || byId(a, b) : bPrice - aPrice || byId(a, b);
    });
  }
  if (sort === "lead-time-asc") {
    return matched.slice().sort((a, b) => {
      const aDays = a.doc.leadTimeDays;
      const bDays = b.doc.leadTimeDays;
      if (aDays == null || bDays == null) {
        return aDays == null && bDays == null ? byId(a, b) : aDays == null ? 1 : -1;
      }
      return aDays - bDays || byId(a, b);
    });
  }
  return matched.slice().sort((a, b) => b.score - a.score || byId(a, b));
}
