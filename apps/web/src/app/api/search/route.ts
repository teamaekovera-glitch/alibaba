import {
  discoverListings,
  type ListingFilters,
  type ListingSearchQuery,
  type VerificationTier,
} from "@packsource/search";
import { db } from "@/lib/db";
import { searchIndex } from "@/lib/search";

/**
 * Listing discovery API — structured JSON results (groundwork the agent-API
 * task extends). The search index backend is the configured singleton; index
 * outages degrade to the Postgres-backed filter search inside
 * discoverListings, so this route never 500s on index unavailability.
 */
export const dynamic = "force-dynamic";

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

  return {
    q: params.get("q") ?? "",
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

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const parsed = parseListingQuery(searchParams);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await discoverListings(db, searchIndex, parsed);
    return Response.json(result);
  } catch (error) {
    // Index outages already degrade to Postgres inside discoverListings —
    // reaching here means Postgres itself failed. Serve a structured 503,
    // never a stack trace.
    console.error("[/api/search] discovery failed", error);
    return Response.json(
      { error: "listing discovery is temporarily unavailable" },
      { status: 503 },
    );
  }
}
