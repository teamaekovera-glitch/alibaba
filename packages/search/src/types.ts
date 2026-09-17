import type { SearchDocument } from "@packsource/ai";
import type { VerificationStatus } from "@packsource/db";

/**
 * Faceted listing-search vocabulary shared by every backend (in-memory mock,
 * Meilisearch) and by the Postgres outage fallback.
 *
 * Documents are a flattened superset of the adapter kit's `SearchDocument`
 * (packages/ai): listing facets live in dedicated typed fields rather than in
 * `attributes`, so Meilisearch filterable attributes, the mock's filter
 * engine, and the Postgres fallback all speak the same grammar.
 */

/** The ten facet groups locked by the spec's Search & AI section. */
export const FACET_FIELDS = [
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
] as const;

export type FacetField = (typeof FACET_FIELDS)[number];

/** Verification tier copied from the Prisma enum (kept as a plain union so the search package stays client-free at the type level). */
export type VerificationTier = `${VerificationStatus}`;

/** Zero-padding target: the `ListingEmbedding.embedding` column dimension committed by the domain-schema migration. */
export const EMBEDDING_COLUMN_DIMENSIONS = 1536;

/**
 * A listing flattened into its searchable document. Enum fields mirror the
 * taxonomy attribute dialect; band fields are bucketed views of the numeric
 * ladder/lead-time data (see bands in ./facets).
 */
export type ListingSearchDocument = SearchDocument & {
  title: string;
  /** Description + spec text, indexed for free-text matching. */
  body: string;
  slug: string;
  /** Top-level category family slug, e.g. "rigid". */
  categoryFamily: string;
  /** Leaf category slug, e.g. "pet-bottles". */
  format: string;
  material: string | null;
  sizeBand: string | null;
  moqBand: string | null;
  priceBand: string | null;
  /** Lowest ladder unit price in integer cents — price sorts/ranges. */
  priceCents: number | null;
  /** Lowest ladder minimum order quantity — MOQ ranges. */
  moqQty: number | null;
  /** Fastest lead-time rule in production days. */
  leadTimeDays: number | null;
  leadTimeBand: string | null;
  /** Primary plant locations of the supplying org. */
  city: string[];
  country: string[];
  /** Primary plant coordinates for geodistance filters. */
  geo: { latitude: number; longitude: number } | null;
  /** Active (non-expired) certification types of the supplying org. */
  certifications: string[];
  /** Sustainability facet group: "recyclable" and/or "compostable". */
  sustainability: string[];
  printMethods: string[];
  verificationTier: VerificationTier;
  /** Numeric shadow of the verification tier — Meilisearch custom ranking rule. */
  verificationRank: number;
  /** True while an active featured placement covers this listing. */
  featured: boolean;
  /** True when any listing attribute is a true boolean (e.g. hotFillCapable). */
  booleanFlags: string[];
  seedIsFictional: boolean;
  updatedAt: string;
};

/** Boolean/negative-free filter grammar: array fields are any-of matches. */
export type ListingFilters = {
  categoryFamily?: string[];
  format?: string[];
  material?: string[];
  sizeBand?: string[];
  moqBand?: string[];
  priceBand?: string[];
  leadTimeBand?: string[];
  city?: string[];
  country?: string[];
  certifications?: string[];
  printMethods?: string[];
  sustainability?: string[];
  verificationTier?: VerificationTier[];
  featured?: boolean;
  booleanFlags?: string[];
  minPriceCents?: number;
  maxPriceCents?: number;
  minMoqQty?: number;
  maxMoqQty?: number;
  maxLeadTimeDays?: number;
  /** Geodistance filter against the listing's primary plant. */
  geo?: { latitude: number; longitude: number; radiusKm: number };
};

export type ListingSort = "relevance" | "price-asc" | "price-desc" | "lead-time-asc";

export type ListingSearchQuery = {
  q: string;
  filters?: ListingFilters;
  sort?: ListingSort;
  limit?: number;
  offset?: number;
};

export type ListingSearchHit = {
  id: string;
  /** 0..1 keyword relevance plus tier/featured boosts (relevance sort only). */
  score: number;
  document: ListingSearchDocument;
};

/** Facet value counts, facet field → value → count. */
export type FacetCounts = Record<string, Record<string, number>>;

/** Which engine produced a result set — surfaced so callers can badge fallbacks. */
export type SearchResultSource = "search-index" | "postgres-fallback";

export type ListingSearchResponse = {
  hits: ListingSearchHit[];
  /** Total matches before limit/offset (exact for the mock and fallback). */
  total: number;
  facetCounts: FacetCounts;
  source: SearchResultSource;
  /** Set only when the index was down and Postgres answered instead. */
  degradedReason?: string;
};

/** A faceted listing-search backend. Mock, Meilisearch, and (via the
 * discovery facade) the Postgres fallback all implement this. */
export interface ListingSearchIndex {
  /** Upsert documents by id; an idempotent full or partial sync. */
  upsert(documents: ListingSearchDocument[]): Promise<void>;
  search(query: ListingSearchQuery): Promise<ListingSearchResponse>;
}
