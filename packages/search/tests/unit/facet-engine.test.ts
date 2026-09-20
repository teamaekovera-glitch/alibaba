import { describe, expect, it } from "vitest";
import {
  facetCounts,
  keywordScore,
  maxTypos,
  matchesFilters,
  toMeilisearchFilter,
  tokenize,
  tokenMatches,
} from "../../src/filtering";
import type { ListingSearchDocument } from "../../src/types";

function doc(overrides: Partial<ListingSearchDocument>): ListingSearchDocument {
  return {
    id: "listing_test",
    title: "12oz PET juice bottle",
    body: "clear hot-fill capable PET bottle with tamper band",
    slug: "test-listing",
    categoryFamily: "bottles-jars",
    format: "juice-bottles",
    material: "PET",
    sizeBand: "small (100–500ml)",
    moqBand: "1K–5K",
    priceBand: "$0.25–$0.50",
    priceCents: 41,
    moqQty: 1_000,
    leadTimeDays: 12,
    leadTimeBand: "1–2 wks",
    city: ["Los Angeles"],
    country: ["US"],
    geo: { latitude: 34.05, longitude: -118.24 },
    certifications: ["SQF"],
    sustainability: ["recyclable"],
    printMethods: ["screen"],
    verificationTier: "VERIFIED",
    verificationRank: 3,
    featured: false,
    booleanFlags: ["hotFillCapable"],
    seedIsFictional: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("tokenize and typo tolerance", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Hot-Fill, 12oz!")).toEqual(["hot", "fill", "12oz"]);
  });

  it("uses the Meilisearch typo budget", () => {
    expect(maxTypos(3)).toBe(0);
    expect(maxTypos(4)).toBe(1);
    expect(maxTypos(7)).toBe(1);
    expect(maxTypos(8)).toBe(2);
  });

  it("matches exact words, prefixes, and typos", () => {
    expect(tokenMatches("bottle", "bottle")).toBe(true);
    expect(tokenMatches("bott", "bottle")).toBe(true);
    expect(tokenMatches("botle", "bottle")).toBe(true);
    expect(tokenMatches("xyz", "bottle")).toBe(false);
  });
});

describe("keywordScore", () => {
  it("is the share of query tokens found in title/body", () => {
    const document = doc({});
    expect(keywordScore(document, ["12oz", "bottle"])).toBe(1);
    expect(keywordScore(document, ["bottle", "glass"])).toBe(0.5);
    expect(keywordScore(document, ["glass"])).toBe(0);
  });

  it("survives typos and short queries", () => {
    expect(keywordScore(doc({}), ["botle"])).toBe(1); // dropped letter, 1-typo budget on 5 chars
  });
});

describe("matchesFilters", () => {
  it("passes an empty filter set", () => {
    expect(matchesFilters(doc({}), {})).toBe(true);
  });

  it("filters string facets any-of", () => {
    expect(matchesFilters(doc({}), { material: ["PET", "GLASS"] })).toBe(true);
    expect(matchesFilters(doc({}), { material: ["GLASS"] })).toBe(false);
  });

  it("filters array facets by overlap", () => {
    expect(matchesFilters(doc({}), { city: ["Los Angeles", "Chicago"] })).toBe(true);
    expect(matchesFilters(doc({}), { certifications: ["BRC"] })).toBe(false);
  });

  it("filters numeric ranges inclusively", () => {
    expect(matchesFilters(doc({}), { minPriceCents: 41, maxPriceCents: 41 })).toBe(true);
    expect(matchesFilters(doc({}), { minPriceCents: 42 })).toBe(false);
    expect(matchesFilters(doc({}), { maxMoqQty: 1_000 })).toBe(true);
    expect(matchesFilters(doc({}), { maxLeadTimeDays: 11 })).toBe(false);
  });

  it("filters boolean flags with AND semantics", () => {
    expect(matchesFilters(doc({}), { booleanFlags: ["hotFillCapable"] })).toBe(true);
    expect(matchesFilters(doc({}), { booleanFlags: ["hotFillCapable", "aseptic"] })).toBe(false);
  });

  it("filters featured equality", () => {
    expect(matchesFilters(doc({}), { featured: false })).toBe(true);
    expect(matchesFilters(doc({}), { featured: true })).toBe(false);
  });

  it("filters geodistance by haversine radius", () => {
    const near = { latitude: 34.05, longitude: -118.24, radiusKm: 50 };
    const far = { latitude: 40.71, longitude: -74.0, radiusKm: 50 };
    expect(matchesFilters(doc({}), { geo: near })).toBe(true);
    expect(matchesFilters(doc({}), { geo: { ...far, radiusKm: 4_000 } })).toBe(true);
    expect(matchesFilters(doc({}), { geo: far })).toBe(false);
  });

  it("requires geo when the listing has no coordinates", () => {
    expect(
      matchesFilters(doc({ geo: null }), { geo: { latitude: 0, longitude: 0, radiusKm: 10 } }),
    ).toBe(false);
  });
});

describe("facetCounts", () => {
  const candidates = [
    doc({ id: "a", material: "PET" }),
    doc({ id: "b", material: "GLASS", city: ["Chicago"] }),
    doc({ id: "c", material: "PET", country: ["MX"] }),
  ];

  it("counts values per facet across the candidate set", () => {
    const counts = facetCounts(candidates, {});
    expect(counts.material).toEqual({ PET: 2, GLASS: 1 });
    expect(counts.country).toEqual({ MX: 1, US: 2 });
  });

  it("applies the remaining filters but skips its own facet", () => {
    const counts = facetCounts(candidates, { material: ["PET"] });
    // material facet: own filter skipped → GLASS still counted
    expect(counts.material).toEqual({ PET: 2, GLASS: 1 });
    // country facet: PET filter applied → only the PET listings remain
    expect(counts.country).toEqual({ MX: 1, US: 1 });
  });

  it("orders by count desc then value asc", () => {
    const counts = facetCounts(
      [
        doc({ id: "a" }),
        doc({ id: "b", city: ["Chicago"] }),
        doc({ id: "c", city: ["Los Angeles"] }),
      ],
      {},
    );
    const cities = Object.entries(counts.city ?? {});
    expect(cities[0]).toEqual(["Los Angeles", 2]);
  });
});

describe("toMeilisearchFilter", () => {
  it("returns undefined for empty filters", () => {
    expect(toMeilisearchFilter({})).toBeUndefined();
    expect(toMeilisearchFilter(undefined)).toBeUndefined();
  });

  it("compiles any-of facets into OR groups", () => {
    expect(toMeilisearchFilter({ material: ["PET", "GLASS"] })).toBe(
      '(material = "PET" OR material = "GLASS")',
    );
  });

  it("combines clauses with AND", () => {
    const filter = toMeilisearchFilter({
      material: ["PET"],
      featured: true,
      maxPriceCents: 100,
      geo: { latitude: 34.05, longitude: -118.24, radiusKm: 50 },
    });
    expect(filter).toBe(
      '(material = "PET") AND featured = true AND priceCents <= 100 AND _geoRadius(34.05, -118.24, 50000)',
    );
  });

  it("escapes double quotes in values", () => {
    expect(toMeilisearchFilter({ city: ['El Paso "TX"'] })).toBe(
      '(city = "El Paso \\"TX\\"")',
    );
  });
});
