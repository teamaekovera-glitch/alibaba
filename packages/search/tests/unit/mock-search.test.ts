import { beforeEach, describe, expect, it } from "vitest";
import { MockListingSearch } from "../../src/mock-faceted-search";
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
    geo: null,
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

const index = new MockListingSearch();

beforeEach(() => {
  index.clear();
  index.upsert([
    doc({ id: "listing_a", title: "12oz PET juice bottle", priceCents: 41 }),
    doc({
      id: "listing_b",
      title: "500ml glass sauce jar",
      material: "GLASS",
      format: "sauce-jars",
      priceCents: 80,
      moqQty: 5_000,
      leadTimeDays: 30,
      leadTimeBand: "2–4 wks",
      verificationTier: "AEKOVERA_VETTED",
      verificationRank: 2,
      featured: true,
      booleanFlags: [],
    }),
    doc({
      id: "listing_c",
      title: "16oz HDQ water bottle",
      material: "HDPE",
      priceCents: null,
      moqQty: null,
      leadTimeDays: null,
      leadTimeBand: null,
      priceBand: null,
      moqBand: null,
      booleanFlags: [],
      certifications: [],
      sustainability: [],
    }),
  ]);
});

describe("MockListingSearch browse", () => {
  it("returns all documents with facet counts and a stable order", async () => {
    const result = await index.search({ q: "" });
    expect(result.total).toBe(3);
    expect(result.source).toBe("search-index");
    expect(result.hits.map((hit) => hit.id)).toEqual(["listing_b", "listing_a", "listing_c"]);
    expect(result.facetCounts.material).toEqual({ PET: 1, GLASS: 1, HDPE: 1 });
  });

  it("respects featured/trust boosts in browse order", async () => {
    const result = await index.search({ q: "" });
    // listing_b: featured + PREFERRED → top; listing_c unverified → last.
    expect(result.hits[0]?.document.featured).toBe(true);
  });

  it("paginates deterministically", async () => {
    const page2 = await index.search({ q: "", limit: 1, offset: 1 });
    expect(page2.hits.map((hit) => hit.id)).toEqual(["listing_a"]);
    expect(page2.total).toBe(3);
  });
});

describe("MockListingSearch keyword search", () => {
  it("ranks the matching document first and excludes non-matches", async () => {
    const result = await index.search({ q: "glass sauce jar" });
    expect(result.hits[0]?.id).toBe("listing_b");
    expect(result.total).toBe(1);
  });

  it("tolerates typos", async () => {
    const result = await index.search({ q: "botle" });
    expect(result.hits.map((hit) => hit.id)).toContain("listing_a");
  });

  it("combines keyword scoring with facet filters", async () => {
    const result = await index.search({ q: "bottle", filters: { material: ["HDPE"] } });
    expect(result.hits.map((hit) => hit.id)).toEqual(["listing_c"]);
  });
});

describe("MockListingSearch sorts", () => {
  it("sorts price ascending with nulls last and id tiebreak", async () => {
    const result = await index.search({ q: "", sort: "price-asc" });
    expect(result.hits.map((hit) => hit.id)).toEqual(["listing_a", "listing_b", "listing_c"]);
  });

  it("sorts price descending with nulls last", async () => {
    const result = await index.search({ q: "", sort: "price-desc" });
    expect(result.hits.map((hit) => hit.id)).toEqual(["listing_b", "listing_a", "listing_c"]);
  });

  it("sorts lead time ascending", async () => {
    const result = await index.search({ q: "", sort: "lead-time-asc" });
    expect(result.hits.map((hit) => hit.id)).toEqual(["listing_a", "listing_b", "listing_c"]);
  });
});
