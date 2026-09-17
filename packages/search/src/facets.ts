import type { ComplianceFramework, VerificationStatus } from "@packsource/db";
import type { ListingSearchDocument, VerificationTier } from "./types";

/**
 * Facet flattening: a ListingGraph (listing + category + ladder + lead times +
 * supplier trust graph) becomes one flat search document. The band buckets
 * below are the canonical MOQ / price / lead-time / size bands used by every
 * backend, so facet counts agree whether the answer comes from Meilisearch,
 * the mock, or the Postgres outage fallback.
 */

// ── Bands (pure, documented buckets) ─────────────────────────────────────────

export const MOQ_BANDS = ["<1K", "1K–5K", "5K–10K", "10K–50K", "50K+"] as const;

export function moqBand(minQty: number): (typeof MOQ_BANDS)[number] {
  if (minQty < 1_000) return "<1K";
  if (minQty < 5_000) return "1K–5K";
  if (minQty < 10_000) return "5K–10K";
  if (minQty < 50_000) return "10K–50K";
  return "50K+";
}

export const PRICE_BANDS = ["<$0.25", "$0.25–$0.50", "$0.50–$1", "$1–$2.50", "$2.50+"] as const;

export function priceBand(cents: number): (typeof PRICE_BANDS)[number] {
  if (cents < 25) return "<$0.25";
  if (cents < 50) return "$0.25–$0.50";
  if (cents < 100) return "$0.50–$1";
  if (cents < 250) return "$1–$2.50";
  return "$2.50+";
}

export const LEAD_TIME_BANDS = ["<1 wk", "1–2 wks", "2–4 wks", "1 mo+"] as const;

export function leadTimeBand(days: number): (typeof LEAD_TIME_BANDS)[number] {
  if (days < 7) return "<1 wk";
  if (days < 14) return "1–2 wks";
  if (days < 30) return "2–4 wks";
  return "1 mo+";
}

export const SIZE_BANDS = ["mini (<100ml)", "small (100–500ml)", "regular (500ml–1L)", "large (1–2L)", "bulk (2L+)"] as const;

export function sizeBand(volumeMl: number): (typeof SIZE_BANDS)[number] {
  if (volumeMl < 100) return "mini (<100ml)";
  if (volumeMl < 500) return "small (100–500ml)";
  if (volumeMl < 1_000) return "regular (500ml–1L)";
  if (volumeMl < 2_000) return "large (1–2L)";
  return "bulk (2L+)";
}

// ── Ranking-rule inputs ──────────────────────────────────────────────────────

/** Numeric shadow of the verification tier (spec: vetted > verified > unverified). */
export function verificationRank(tier: VerificationTier): number {
  if (tier === "AEKOVERA_VETTED") return 2;
  if (tier === "VERIFIED") return 1;
  return 0;
}

/** Relevance boost within ties: featured placement outranks plain verification. */
export function tierBoost(doc: Pick<ListingSearchDocument, "verificationTier" | "featured">): number {
  const tier = doc.featured ? 0.15 : 0;
  const rank = verificationRank(doc.verificationTier) * 0.05;
  return tier + rank;
}

// ── Document builder ─────────────────────────────────────────────────────────

/**
 * The structural slice of the listing graph the facet flattener reads. The
 * Prisma payload from ./listing-graph satisfies this; keeping the type here
 * structural keeps the flattener pure and unit-testable without a client.
 */
export type FacetSourceListing = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  attributes: unknown; // Prisma Json — validated per category at write time
  seedIsFictional: boolean;
  updatedAt: Date;
  category: { slug: string; parent: { slug: string } | null };
  moqTiers: { minQty: number; unitPriceCents: number }[];
  leadTimes: { productionDays: number }[];
  complianceClaims: { framework: ComplianceFramework }[];
  featuredPlacements: { status: string; startsAt: Date; endsAt: Date }[];
  org: {
    supplierProfile: {
      verificationStatus: VerificationStatus;
      certifications: { type: string; expiresAt: Date }[];
      plants: {
        city: string;
        country: string;
        latitude: number | null;
        longitude: number | null;
        isPrimary: boolean;
      }[];
    } | null;
  };
};

type AttributeValues = Record<string, unknown>;

const SUSTAINABILITY_CLAIMS: Record<string, string> = {
  RECYCLABLE: "recyclable",
  COMPOSTABLE: "compostable",
};

/** True boolean attributes become filterable flags, e.g. "hotFillCapable". */
export function booleanFlagsOf(attributes: AttributeValues): string[] {
  return Object.entries(attributes)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
    .sort();
}

/** Enum/array/number attributes flattened into the body text for free-text matching. */
function attributesToBody(attributes: AttributeValues): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(" ") : String(value)}`)
    .join(". ");
}

function sustainabilityOf(
  attributes: AttributeValues,
  claims: { framework: ComplianceFramework }[],
): string[] {
  const values = new Set<string>();
  if (attributes["recyclability"] === "WIDELY_RECYCLABLE") {
    values.add("recyclable");
  }
  for (const claim of claims) {
    const mapped = SUSTAINABILITY_CLAIMS[claim.framework];
    if (mapped) {
      values.add(mapped);
    }
  }
  return [...values].sort();
}

/** Build the flat search document from a loaded listing graph. `now` decides
 * certification validity and featured-placement activity (server clock at sync
 * time — fixtures use wide windows to stay deterministic). */
export function listingGraphToDocument(
  listing: FacetSourceListing,
  now: Date = new Date(),
): ListingSearchDocument {
  const attributes = (listing.attributes ?? {}) as AttributeValues;
  const profile = listing.org.supplierProfile;

  const ladders = listing.moqTiers.map((tier) => ({ minQty: tier.minQty, priceCents: tier.unitPriceCents }));
  const lowestPrice = ladders.length > 0 ? Math.min(...ladders.map((l) => l.priceCents)) : null;
  const lowestMoq = ladders.length > 0 ? Math.min(...ladders.map((l) => l.minQty)) : null;
  const fastestLead = listing.leadTimes.length > 0 ? Math.min(...listing.leadTimes.map((rule) => rule.productionDays)) : null;

  const activeCerts = profile
    ? profile.certifications.filter((cert) => cert.expiresAt.getTime() > now.getTime()).map((cert) => cert.type).sort()
    : [];

  const activePlacements = listing.featuredPlacements.filter(
    (placement) =>
      placement.status === "ACTIVE" &&
      placement.endsAt.getTime() > now.getTime() &&
      placement.startsAt.getTime() <= now.getTime(),
  );

  const plants = profile?.plants ?? [];
  const primary = plants.find((plant) => plant.isPrimary) ?? plants[0];

  const volumeMl = typeof attributes["volumeMl"] === "number" ? attributes["volumeMl"] : null;
  const description = listing.description ?? "";

  return {
    id: listing.id,
    title: listing.title,
    body: `${description} ${attributesToBody(attributes)}`.trim(),
    slug: listing.slug,
    categoryFamily: listing.category.parent?.slug ?? listing.category.slug,
    format: listing.category.slug,
    material: typeof attributes["material"] === "string" ? attributes["material"] : null,
    sizeBand: volumeMl !== null ? sizeBand(volumeMl) : null,
    moqBand: lowestMoq !== null ? moqBand(lowestMoq) : null,
    priceBand: lowestPrice !== null ? priceBand(lowestPrice) : null,
    priceCents: lowestPrice,
    moqQty: lowestMoq,
    leadTimeDays: fastestLead,
    leadTimeBand: fastestLead !== null ? leadTimeBand(fastestLead) : null,
    city: plants.map((plant) => plant.city).sort(),
    country: [...new Set(plants.map((plant) => plant.country))].sort(),
    geo:
      primary?.latitude != null && primary?.longitude != null
        ? { latitude: primary.latitude, longitude: primary.longitude }
        : null,
    certifications: activeCerts,
    sustainability: sustainabilityOf(attributes, listing.complianceClaims),
    printMethods: Array.isArray(attributes["printMethod"])
      ? (attributes["printMethod"] as string[]).slice().sort()
      : [],
    verificationTier: profile?.verificationStatus ?? "UNVERIFIED",
    verificationRank: verificationRank(profile?.verificationStatus ?? "UNVERIFIED"),
    featured: activePlacements.length > 0,
    booleanFlags: booleanFlagsOf(attributes),
    seedIsFictional: listing.seedIsFictional,
    updatedAt: listing.updatedAt.toISOString(),
  };
}
