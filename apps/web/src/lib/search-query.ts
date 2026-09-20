import {
  type ListingFilters,
  type ListingSearchMode,
  type ListingSearchQuery,
  type VerificationTier,
} from "@packsource/search";

/**
 * Pure query-string to ListingSearchQuery parser for the listing discovery
 * API. Kept out of the route module: Next.js route files may only export
 * route handlers, and this parser is unit-tested in its own right.
 */

const FACET_PARAMS = [
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
  "booleanFlags",
  "verificationTier",
] as const;

const SORTS = ["relevance", "price-asc", "price-desc", "lead-time-asc"] as const;

const VERIFICATION_TIERS: VerificationTier[] = ["UNVERIFIED", "VERIFIED", "AEKOVERA_VETTED"];
type NumericFilterKey =
  | "minPriceCents"
  | "maxPriceCents"
  | "minMoqQty"
  | "maxMoqQty"
  | "maxLeadTimeDays";

/** Pure query-string → ListingSearchQuery parser (unit-tested). */
export function parseListingQuery(
  params: URLSearchParams,
): ListingSearchQuery | { error: string } {
  const filters: ListingFilters = {};

  for (const param of FACET_PARAMS) {
    if (param === "verificationTier") continue; // validated against the tier union below
    const raw = params.get(param);
    if (!raw) continue;
    const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length > 0) {
      filters[param] = values;
    }
  }

  const tierRaw = params.get("verificationTier");
  if (tierRaw) {
    const values = tierRaw.split(",").map((value) => value.trim()).filter(Boolean);
    const invalid = values.filter((value) => !VERIFICATION_TIERS.includes(value as VerificationTier));
    if (invalid.length > 0) {
      return { error: `verificationTier must be one of ${VERIFICATION_TIERS.join(", ")}` };
    }
    filters.verificationTier = values as VerificationTier[];
  }

  const numericParams: [NumericFilterKey, string][] = [
    ["minPriceCents", "minPriceCents"],
    ["maxPriceCents", "maxPriceCents"],
    ["minMoqQty", "minMoqQty"],
    ["maxMoqQty", "maxMoqQty"],
    ["maxLeadTimeDays", "maxLeadTimeDays"],
  ];
  for (const [key, param] of numericParams) {
    const raw = params.get(param);
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      return { error: `${param} must be a non-negative number` };
    }
    filters[key] = value;
  }

  const featured = params.get("featured");
  if (featured === "true") filters.featured = true;
  else if (featured === "false") filters.featured = false;

  const geo = params.get("geo");
  if (geo) {
    const [latitude, longitude, radiusKm] = geo.split(",").map(Number);
    if (
      latitude == null || !Number.isFinite(latitude) ||
      longitude == null || !Number.isFinite(longitude) ||
      radiusKm == null || !Number.isFinite(radiusKm) || radiusKm <= 0
    ) {
      return { error: "geo must be latitude,longitude,radiusKm" };
    }
    filters.geo = { latitude, longitude, radiusKm };
  }

  const sortRaw = params.get("sort") ?? "relevance";
  if (!(SORTS as readonly string[]).includes(sortRaw)) {
    return { error: `sort must be one of ${SORTS.join(", ")}` };
  }

  const modeRaw = params.get("mode") ?? "relevance";
  if (modeRaw !== "relevance" && modeRaw !== "hybrid") {
    return { error: "mode must be one of relevance, hybrid" };
  }
  const mode: ListingSearchMode = modeRaw;

  return {
    q: params.get("q") ?? "",
    mode,
    filters,
    sort: sortRaw as ListingSearchQuery["sort"],
    limit: clamp(params.get("limit"), 1, 50, 10),
    offset: clamp(params.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

function clamp(raw: string | null, min: number, max: number, fallback: number): number {
  const value = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
