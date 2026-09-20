import { beforeAll, describe, expect, it } from "vitest";
import {
  MockEmbeddingAdapter,
  MockVisionAdapter,
  type EmbeddingAdapter,
  type EmbeddingResponse,
  type VisionAdapter,
  type VisionResult,
} from "@packsource/ai";
import { PrismaClient } from "@packsource/db";
import {
  FACET_FIELDS,
  discoverListings,
  discoverListingsHybrid,
  hybridSearchListings,
  listingGraphToDocument,
  loadListingGraphs,
  matchesFilters,
  semanticInputText,
  semanticSearchListings,
  backfillListingEmbeddings,
  visualSearchListings,
} from "../../src/index";
import { MockListingSearch } from "../../src/mock-faceted-search";
import type { ListingSearchDocument, ListingSearchIndex, ListingSearchQuery } from "../../src/types";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

/** Canonical fixture query from the spec's verification table. */
const HOT_FILL_QUERY = "clear 12oz hot-fill bottle with tamper band";
/** Fixture target: first seeded hot-fill capable listing (stable seed ids). */
const TARGET_ID = "seed_listing_0001";
/** Unit vector along axis 0 — the fixture embedding for target texts. */
const UNIT_X = [1, 0, 0, 0, 0, 0, 0, 0];

/**
 * Fixture-keyed embedding adapter. ONLY the fixture's exact texts (the target
 * listing's semanticInputText, the canonical NL query, and the fixture visual
 * tag texts) map to the unit vector — everything else falls back to the
 * deterministic mock hash vector. Exact keys matter: a substring heuristic
 * would store the fixture vector for every seeded bottle listing, and the
 * canonical query would tie at similarity 1.0 across dozens of rows.
 */
const FIXTURE_QUERY_TEXTS = ["bottle", "pet bottle", HOT_FILL_QUERY];
class FixtureEmbedding implements EmbeddingAdapter {
  constructor(private readonly keyed: Record<string, number[]>) {}
  async embed(text: string): Promise<EmbeddingResponse> {
    const vector = this.keyed[text] ?? (FIXTURE_QUERY_TEXTS.includes(text) ? UNIT_X : null)
      ?? (await FALLBACK_MOCK.embed(text)).vector;
    return { vector, model: "fixture-embedding", dimensions: vector.length };
  }
  async embedBatch(texts: string[]): Promise<EmbeddingResponse[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}
const FALLBACK_MOCK = new MockEmbeddingAdapter();

/** Fixture vision adapter returning a fixed label set. */
class FixtureVision implements VisionAdapter {
  constructor(private readonly labels: string[]) {}
  async classify(): Promise<VisionResult> {
    return { labels: this.labels, model: "fixture-vision", inputHash: "fixture-input-hash" };
  }
}

/** Index stub that always fails — simulates a Meilisearch outage. */
const OUTAGE_INDEX: ListingSearchIndex = {
  upsert: async () => undefined,
  search: async () => {
    throw new Error("simulated search index outage");
  },
};

let documents: ListingSearchDocument[];
let targetText = "";
const index = new MockListingSearch();

beforeAll(async () => {
  await prisma.$connect();
  // Deterministic per-suite handoff: integration suites share one database
  // and turbo schedules their tasks in nondeterministic order, so inherited
  // state is unsafe — a non-empty graph of stale or non-LIVE rows would
  // defeat a count-guarded seed. Truncate the core graph (CASCADE clears
  // every table that references these rows, mirroring the seed suite's
  // beforeAll) and reseed unconditionally: order-independent by construction.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "Category", "PriceBenchmark" CASCADE`,
  );
  const { seedDatabase } = await import("@packsource/db/seed");
  await seedDatabase(prisma);
  documents = (await loadListingGraphs(prisma)).map((graph) =>
    listingGraphToDocument(graph, new Date()),
  );
  index.upsert(documents);
});

describe("facet matrix over seeded data", () => {
  it("loads every LIVE listing into the index and browses with facets", async () => {
    const response = await discoverListings(prisma, index, { q: "", limit: 10 });
    expect(response.source).toBe("search-index");
    expect(response.total).toBe(documents.length);
    expect(response.hits).toHaveLength(10);
    for (const field of FACET_FIELDS) {
      if (field === "certifications") {
        // Known seed gap: PR #5's seed attaches no supplier certifications,
        // so this facet is legitimately empty on the seeded corpus.
        expect(Object.keys(response.facetCounts.certifications ?? {}).length).toBe(0);
        continue;
      }
      expect(Object.keys(response.facetCounts[field] ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("filters correctly for the top value of every facet", async () => {
    const browse = await discoverListings(prisma, index, { q: "" });
    for (const field of FACET_FIELDS) {
      const counts = browse.facetCounts[field] ?? {};
      const [topValue, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [];
      if (topValue == null) continue; // no values for this facet in the seed

      const query: ListingSearchQuery = {
        q: "",
        // Test-boundary cast: topValue is typed string; the facet predicate
        // itself is string-based, and verificationTier values in the seed
        // come from the same enum vocabulary.
        filters: { [field]: [topValue] } as ListingSearchQuery["filters"],
        limit: 25,
      };
      const response = await discoverListings(prisma, index, query);
      expect(response.total).toBeGreaterThan(0);
      expect(response.total).toBe(topCount);
      for (const hit of response.hits) {
        expect(matchesFilters(hit.document, query.filters ?? {})).toBe(true);
      }
      // Faceted counts respect the remaining filters for other facets.
      expect(browse.facetCounts[field]?.[topValue]).toBe(topCount);
    }
  });

  it("narrows results with numeric ranges and sorts deterministically", async () => {
    const browse = await discoverListings(prisma, index, { q: "" });
    const prices = browse.hits.map((hit) => hit.document.priceCents).filter((p) => p != null);
    expect(prices.length).toBeGreaterThan(0);

    const maxPrice = Math.max(...(prices as number[]));
    const response = await discoverListings(prisma, index, {
      q: "",
      filters: { maxPriceCents: maxPrice },
      sort: "price-asc",
      limit: 50,
    });
    const sorted = response.hits
      .map((hit) => hit.document.priceCents)
      .filter((p) => p != null) as number[];
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
    expect(sorted.every((p) => p <= maxPrice)).toBe(true);
  });

  it("applies geodistance filtering when listings carry coordinates", async () => {
    const withGeo = documents.find((doc) => doc.geo != null);
    if (!withGeo?.geo) {
      // The seed ships no plant coordinates; the geo predicate is covered by
      // the facet-engine unit tests until coordinates arrive.
      expect(withGeo).toBeUndefined();
      return;
    }
    const response = await discoverListings(prisma, index, {
      q: "",
      filters: { geo: { ...withGeo.geo, radiusKm: 100 } },
    });
    for (const hit of response.hits) {
      expect(hit.document.geo).not.toBeNull();
    }
  });
});

describe("pgvector semantic fixture", () => {
  beforeAll(async () => {
    const full = (await loadListingGraphs(prisma, [TARGET_ID]))[0];
    if (!full) throw new Error("fixture listing missing");
    targetText = semanticInputText(listingGraphToDocument(full, new Date()));
  });

  it("backfills TITLE embeddings for every LIVE listing", async () => {
    const result = await backfillListingEmbeddings(prisma, new FixtureEmbedding({ [targetText]: UNIT_X }), {
      batchSize: 500,
      overwrite: true,
    });
    expect(result.processed).toBe(documents.length);
    expect(result.dimensions).toBe(1536);

    const stored = await prisma.$queryRaw<{ dimensions: number }[]>`
      SELECT dimensions FROM "ListingEmbedding" WHERE "listingId" = ${TARGET_ID}`;
    expect(stored[0]?.dimensions).toBe(1536);
  });

  it("skips already-embedded listings on rerun (idempotent)", async () => {
    const result = await backfillListingEmbeddings(
      prisma,
      new FixtureEmbedding({ [targetText]: UNIT_X }),
      { batchSize: 500 },
    );
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(documents.length);
  });

  it("ranks the seeded hot-fill bottle in the top 3 for the canonical query", async () => {
    const matches = await semanticSearchListings(prisma, new FixtureEmbedding({ [targetText]: UNIT_X }), {
      text: HOT_FILL_QUERY,
      limit: 10,
    });
    expect(matches.length).toBeGreaterThan(0);
    const rank = matches.findIndex((match) => match.listingId === TARGET_ID);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
    expect(matches[0]?.listingId).toBe(TARGET_ID);
    expect(matches[0]?.similarity).toBeCloseTo(1, 5);
  });

  it("merges keyword and semantic legs in the hybrid path", async () => {
    const matches = await hybridSearchListings(prisma, index, new FixtureEmbedding({ [targetText]: UNIT_X }), {
      q: HOT_FILL_QUERY,
      limit: 10,
    });
    expect(matches.length).toBeGreaterThan(0);
    const target = matches.find((match) => match.listingId === TARGET_ID);
    expect(target).toBeDefined();
    expect(target?.semanticScore).toBe(1);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1]!.score).toBeGreaterThanOrEqual(matches[i]!.score);
    }
  });
});

describe("visual search fixture", () => {
  it("maps fixture photo tags to facet filters and ranks same-material items first", async () => {
    const target = documents.find((doc) => doc.id === TARGET_ID);
    expect(target?.material).toBe("PET"); // fixture requires a PET-seeded target

    const vision = new FixtureVision(["pet", "bottle"]);
    const matches = await visualSearchListings(prisma, vision, new FixtureEmbedding({ [targetText]: UNIT_X }), {
      base64: "Zml4dHVyZS1waG90bw==",
      mimeType: "image/png",
    }, { limit: 10 });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.listingId).toBe(TARGET_ID);
    expect(matches[0]?.tags.labels).toEqual(["pet", "bottle"]);
    expect(matches[0]?.appliedFilters.material).toEqual(["PET"]);
    for (const match of matches) {
      expect(match.document.id).not.toBe("");
      expect(match.appliedFilters.material).toEqual(["PET"]);
    }
  });

  it("is deterministic for the same uploaded bytes", async () => {
    const vision = new MockVisionAdapter();
    const image = { base64: "Zml4dHVyZS1waG90bw==", mimeType: "image/png" };
    const embedding = new FixtureEmbedding({});
    const first = await visualSearchListings(prisma, vision, embedding, image, { limit: 5 });
    const second = await visualSearchListings(prisma, vision, embedding, image, { limit: 5 });
    expect(first.map((m) => [m.listingId, m.similarity])).toEqual(
      second.map((m) => [m.listingId, m.similarity]),
    );
    expect(first[0]?.tags.inputHash).toBe(second[0]?.tags.inputHash);
  });
});

describe("search index outage fallback", () => {
  it("serves discovery from Postgres when the index is unavailable", async () => {
    const response = await discoverListings(prisma, OUTAGE_INDEX, { q: "", limit: 5 });
    expect(response.source).toBe("postgres-fallback");
    expect(response.total).toBe(documents.length);
    expect(response.hits).toHaveLength(5);
  });

  it("keeps keyword+facet discovery working during the outage", async () => {
    const response = await discoverListings(prisma, OUTAGE_INDEX, {
      q: "bottle",
      filters: { material: ["PET"] },
      limit: 5,
    });
    expect(response.source).toBe("postgres-fallback");
    for (const hit of response.hits) {
      expect(matchesFilters(hit.document, { material: ["PET"] })).toBe(true);
    }
  });

  it("hybrid discovery degrades without a 500 during the outage", async () => {
    const result = await discoverListingsHybrid(prisma, OUTAGE_INDEX, new FixtureEmbedding({}), {
      q: HOT_FILL_QUERY,
      limit: 5,
    });
    expect(Array.isArray(result)).toBe(false);
    const response = result as Exclude<typeof result, unknown[]>;
    expect(response.source).toBe("postgres-fallback");
    expect(response.total).toBeGreaterThan(0);
  });
});
