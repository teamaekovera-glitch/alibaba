import { describe, expect, it } from "vitest";
import {
  booleanFlagsOf,
  leadTimeBand,
  listingGraphToDocument,
  moqBand,
  priceBand,
  sizeBand,
  verificationRank,
  type FacetSourceListing,
} from "../../src/facets";

/** Deterministic "now" — fixtures pin every time-relative field against it. */
const NOW = new Date("2026-09-17T12:00:00.000Z");

function baseListing(overrides: Partial<FacetSourceListing> = {}): FacetSourceListing {
  return {
    id: "listing_1",
    title: "Clear 12oz Hot-Fill PET Bottle",
    slug: "clear-12oz-hot-fill-pet-bottle",
    description: "Food-contact bottle for hot-fill juice lines.",
    attributes: {
      material: "PET",
      volumeMl: 355,
      hotFillCapable: true,
      printMethod: ["OFFSET", "DIGITAL"],
    },
    images: null,
    seedIsFictional: true,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    category: { slug: "pet-bottles", parent: { slug: "rigid" } },
    moqTiers: [
      { minQty: 10_000, unitPriceCents: 41 },
      { minQty: 1_000, unitPriceCents: 55 },
    ],
    leadTimes: [{ productionDays: 12 }],
    complianceClaims: [{ framework: "RECYCLABLE" }],
    featuredPlacements: [],
    org: {
      supplierProfile: {
        verificationStatus: "VERIFIED",
        certifications: [{ type: "SQF", expiresAt: new Date("2027-01-01T00:00:00.000Z") }],
        plants: [{ city: "Portland", country: "US", latitude: 45.52, longitude: -122.68, isPrimary: true }],
      },
    },
    ...overrides,
  };
}

describe("facet bands", () => {
  it("buckets MOQ quantities at documented boundaries", () => {
    expect(moqBand(999)).toBe("<1K");
    expect(moqBand(1_000)).toBe("1K–5K");
    expect(moqBand(4_999)).toBe("1K–5K");
    expect(moqBand(10_000)).toBe("10K–50K");
    expect(moqBand(50_000)).toBe("50K+");
  });

  it("buckets unit prices at documented boundaries", () => {
    expect(priceBand(24)).toBe("<$0.25");
    expect(priceBand(25)).toBe("$0.25–$0.50");
    expect(priceBand(100)).toBe("$1–$2.50");
    expect(priceBand(250)).toBe("$2.50+");
  });

  it("buckets lead times and volumes", () => {
    expect(leadTimeBand(6)).toBe("<1 wk");
    expect(leadTimeBand(7)).toBe("1–2 wks");
    expect(leadTimeBand(30)).toBe("1 mo+");
    expect(sizeBand(99)).toBe("mini (<100ml)");
    expect(sizeBand(355)).toBe("small (100–500ml)");
    expect(sizeBand(2_000)).toBe("bulk (2L+)");
  });
});

describe("listingGraphToDocument", () => {
  it("flattens category, facets, and ladder extremes", () => {
    const doc = listingGraphToDocument(baseListing(), NOW);

    expect(doc.categoryFamily).toBe("rigid");
    expect(doc.format).toBe("pet-bottles");
    expect(doc.material).toBe("PET");
    expect(doc.priceCents).toBe(41); // lowest ladder rung, not the first
    expect(doc.moqQty).toBe(1_000);
    expect(doc.moqBand).toBe("1K–5K");
    expect(doc.priceBand).toBe("$0.25–$0.50");
    expect(doc.leadTimeDays).toBe(12);
    expect(doc.leadTimeBand).toBe("1–2 wks");
    expect(doc.sizeBand).toBe("small (100–500ml)");
    expect(doc.booleanFlags).toEqual(["hotFillCapable"]);
    expect(doc.sustainability).toEqual(["recyclable"]);
    expect(doc.printMethods).toEqual(["DIGITAL", "OFFSET"]);
    expect(doc.city).toEqual(["Portland"]);
    expect(doc.geo).toEqual({ latitude: 45.52, longitude: -122.68 });
  });

  it("excludes expired certifications and inactive placements", () => {
    const doc = listingGraphToDocument(
      baseListing({
        featuredPlacements: [
          { status: "ACTIVE", startsAt: new Date("2026-01-01"), endsAt: new Date("2026-09-01") }, // ended
          { status: "ACTIVE", startsAt: new Date("2026-01-01"), endsAt: new Date("2027-09-01") }, // live
        ],
        org: {
          supplierProfile: {
            verificationStatus: "AEKOVERA_VETTED",
            certifications: [
              { type: "SQF", expiresAt: new Date("2027-01-01") },
              { type: "BRCGS", expiresAt: new Date("2026-01-01") }, // expired
            ],
            plants: [],
          },
        },
      }),
      NOW,
    );

    expect(doc.certifications).toEqual(["SQF"]);
    expect(doc.featured).toBe(true);
    expect(doc.verificationRank).toBe(2);
    expect(doc.city).toEqual([]);
    expect(doc.geo).toBeNull();
  });

  it("keeps a listing without a supplier profile searchable as UNVERIFIED", () => {
    const doc = listingGraphToDocument(baseListing({ org: { supplierProfile: null } }), NOW);
    expect(doc.verificationTier).toBe("UNVERIFIED");
    expect(doc.certifications).toEqual([]);
  });
});

describe("trust ranking helpers", () => {
  it("orders verification tiers", () => {
    expect(verificationRank("UNVERIFIED")).toBe(0);
    expect(verificationRank("VERIFIED")).toBe(1);
    expect(verificationRank("AEKOVERA_VETTED")).toBe(2);
  });
});

describe("booleanFlagsOf", () => {
  it("collects true-valued attribute keys in sorted order", () => {
    expect(booleanFlagsOf({ hotFillCapable: true, reclosable: false, tamperBand: true })).toEqual([
      "hotFillCapable",
      "tamperBand",
    ]);
  });
});
