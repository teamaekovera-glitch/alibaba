import type {
  FacetCounts,
  FacetField,
  ListingFilters,
  ListingSearchDocument,
} from "./types";

/** Facet fields plus the verification filter, which ranks but is not counted as a facet. */
type FilterField = FacetField | "verificationTier";

/**
 * The facet engine shared by every backend: deterministic tokenization with
 * Meilisearch-style typo tolerance, the facet filter predicate, keyword
 * scoring, facet counting, and the Meilisearch filter compiler. The in-memory
 * mock and the Postgres outage fallback both evaluate this exact code, so
 * filter and facet-count semantics cannot drift between engines; the
 * Meilisearch adapter compiles the same grammar into its native syntax.
 */

// ── Tokenization & typo tolerance ────────────────────────────────────────────

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Meilisearch-flavored typo budget: 0 typos under 4 chars, 1 under 8, 2 above. */
export function maxTypos(queryTokenLength: number): number {
  if (queryTokenLength < 4) return 0;
  if (queryTokenLength < 8) return 1;
  return 2;
}

/** A query token matches a document word exactly, as a prefix, or within the typo budget. */
export function tokenMatches(queryToken: string, word: string): boolean {
  if (word === queryToken) return true;
  if (queryToken.length >= 3 && word.startsWith(queryToken)) return true;
  return levenshtein(queryToken, word) <= maxTypos(queryToken.length);
}

function documentWords(doc: ListingSearchDocument): string[] {
  return tokenize(`${doc.title} ${doc.body}`);
}

/**
 * Keyword relevance: the share of query tokens found in title/body (0 for
 * browse queries with no tokens).
 */
export function keywordScore(doc: ListingSearchDocument, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const words = documentWords(doc);
  const matched = tokens.filter((token) => words.some((word) => tokenMatches(token, word))).length;
  return matched / tokens.length;
}

// ── Filter predicate ─────────────────────────────────────────────────────────

function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function facetValues(doc: ListingSearchDocument, field: FilterField): string[] {
  const value = doc[field];
  if (Array.isArray(value)) return value;
  return value != null ? [String(value)] : [];
}

function anyOf(doc: ListingSearchDocument, field: FilterField, allowed: string[]): boolean {
  const values = facetValues(doc, field);
  return allowed.some((candidate) => values.includes(candidate));
}

/**
 * The facet filter predicate — the single source of truth for what a filter
 * means. `skip` excludes one facet's own filter (faceted-count computation).
 */
export function matchesFilters(
  doc: ListingSearchDocument,
  filters: ListingFilters,
  skip?: FacetField,
): boolean {
  const facetAnyOf: [FilterField, string[] | undefined][] = [
    ["categoryFamily", filters.categoryFamily],
    ["format", filters.format],
    ["material", filters.material],
    ["sizeBand", filters.sizeBand],
    ["moqBand", filters.moqBand],
    ["priceBand", filters.priceBand],
    ["leadTimeBand", filters.leadTimeBand],
    ["city", filters.city],
    ["country", filters.country],
    ["certifications", filters.certifications],
    ["printMethods", filters.printMethods],
    ["sustainability", filters.sustainability],
    ["verificationTier", filters.verificationTier],
  ];
  for (const [field, allowed] of facetAnyOf) {
    if (field === skip || !allowed || allowed.length === 0) continue;
    if (!anyOf(doc, field, allowed)) return false;
  }

  if (filters.featured !== undefined && !skip && doc.featured !== filters.featured) {
    return false;
  }
  if (
    filters.booleanFlags &&
    filters.booleanFlags.length > 0 &&
    !filters.booleanFlags.every((flag) => doc.booleanFlags.includes(flag))
  ) {
    return false;
  }
  if (skip !== "priceBand") {
    if (filters.minPriceCents !== undefined && (doc.priceCents == null || doc.priceCents < filters.minPriceCents)) return false;
    if (filters.maxPriceCents !== undefined && (doc.priceCents == null || doc.priceCents > filters.maxPriceCents)) return false;
  }
  if (skip !== "moqBand") {
    if (filters.minMoqQty !== undefined && (doc.moqQty == null || doc.moqQty < filters.minMoqQty)) return false;
    if (filters.maxMoqQty !== undefined && (doc.moqQty == null || doc.moqQty > filters.maxMoqQty)) return false;
  }
  if (skip !== "leadTimeBand" && filters.maxLeadTimeDays !== undefined) {
    if (doc.leadTimeDays == null || doc.leadTimeDays > filters.maxLeadTimeDays) return false;
  }
  if (filters.geo) {
    if (skip !== "city" && !doc.geo) return false;
    if (doc.geo && skip !== "city" && haversineKm(doc.geo, filters.geo) > filters.geo.radiusKm) {
      return false;
    }
  }
  return true;
}

// ── Facet counting ───────────────────────────────────────────────────────────

const FACET_COUNT_FIELDS: FacetField[] = [
  "categoryFamily",
  "format",
  "material",
  "sizeBand",
  "moqBand",
  "priceBand",
  "leadTimeBand",
  "city",
  "country",
  "certifications",
  "sustainability",
  "printMethods",
];

/**
 * Facet value counts over a candidate set. For each facet field the candidate
 * set is filtered with that field's own filter excluded — standard faceted
 * browse semantics (selecting a value never zeroes out its own count).
 */
export function facetCounts(
  candidates: ListingSearchDocument[],
  filters: ListingFilters,
): FacetCounts {
  const counts: FacetCounts = {};
  for (const field of FACET_COUNT_FIELDS) {
    const values: Record<string, number> = {};
    for (const doc of candidates) {
      if (!matchesFilters(doc, filters, field)) continue;
      for (const value of facetValues(doc, field)) {
        values[value] = (values[value] ?? 0) + 1;
      }
    }
    counts[field] = sortCounts(values);
  }
  return counts;
}

/** Deterministic order: count desc, then value asc. */
function sortCounts(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).sort(
      ([valueA, countA], [valueB, countB]) => countB - countA || valueA.localeCompare(valueB),
    ),
  );
}

// ── Meilisearch filter compilation ───────────────────────────────────────────

/**
 * Compiles the facet filter grammar into Meilisearch's expression syntax.
 * Returns undefined when no filters are set.
 */
export function toMeilisearchFilter(filters: ListingFilters | undefined): string | undefined {
  if (!filters) return undefined;
  const clauses: string[] = [];

  const anyOfClauses: [string, string[] | undefined][] = [
    ["categoryFamily", filters.categoryFamily],
    ["format", filters.format],
    ["material", filters.material],
    ["sizeBand", filters.sizeBand],
    ["moqBand", filters.moqBand],
    ["priceBand", filters.priceBand],
    ["leadTimeBand", filters.leadTimeBand],
    ["city", filters.city],
    ["country", filters.country],
    ["certifications", filters.certifications],
    ["printMethods", filters.printMethods],
    ["sustainability", filters.sustainability],
    ["verificationTier", filters.verificationTier],
    ["booleanFlags", filters.booleanFlags],
  ];
  for (const [field, allowed] of anyOfClauses) {
    if (!allowed || allowed.length === 0) continue;
    clauses.push(`(${allowed.map((value) => meiliEquality(field, value)).join(" OR ")})`);
  }
  if (filters.featured !== undefined) {
    clauses.push(`featured = ${filters.featured}`);
  }
  if (filters.minPriceCents !== undefined) clauses.push(`priceCents >= ${filters.minPriceCents}`);
  if (filters.maxPriceCents !== undefined) clauses.push(`priceCents <= ${filters.maxPriceCents}`);
  if (filters.minMoqQty !== undefined) clauses.push(`moqQty >= ${filters.minMoqQty}`);
  if (filters.maxMoqQty !== undefined) clauses.push(`moqQty <= ${filters.maxMoqQty}`);
  if (filters.maxLeadTimeDays !== undefined) clauses.push(`leadTimeDays <= ${filters.maxLeadTimeDays}`);
  if (filters.geo) {
    const meters = Math.round(filters.geo.radiusKm * 1000);
    clauses.push(`_geoRadius(${filters.geo.latitude}, ${filters.geo.longitude}, ${meters})`);
  }
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

function meiliEquality(field: string, value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${field} = "${escaped}"`;
}