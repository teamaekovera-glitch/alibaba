import { describe, expect, it } from "vitest";
import {
  aggregateLeadTimeBenchmarks,
  aggregatePriceBenchmarks,
  nearestRankQuantile,
  qtyBandFor,
  QTY_BANDS,
  QuantityOutOfRangeError,
} from "../../src/core";
import {
  fixtureLeadTimeSamples,
  fixturePriceSamples,
  FIXTURE_CATEGORY,
  FIXTURE_GLASS_STATS,
  FIXTURE_PET_LEAD_STATS,
  FIXTURE_PET_STATS,
  FIXTURE_RARE_CATEGORY,
} from "../../src/fixtures";

/**
 * K-anonymous benchmarks (spec: analytics). Hard k-threshold: groups below
 * k return NO row; integer-cent arithmetic is exact (nearest-rank quantiles
 * over actual sample values).
 */

describe("qtyBandFor", () => {
  it("maps quantities onto canonical band keys", () => {
    expect(qtyBandFor(1)).toBe("1-999");
    expect(qtyBandFor(999)).toBe("1-999");
    expect(qtyBandFor(1000)).toBe("1000-4999");
    expect(qtyBandFor(12_000)).toBe("10000-24999");
    expect(qtyBandFor(50_000)).toBe("50000-99999");
    expect(qtyBandFor(250_000)).toBe("100000+");
  });

  it("rejects non-positive quantities — loudly", () => {
    expect(() => qtyBandFor(0)).toThrow(QuantityOutOfRangeError);
    expect(() => qtyBandFor(-5)).toThrow(QuantityOutOfRangeError);
  });

  it("covers every integer >= 1 with no gaps between bands", () => {
    let previousMax = 0;
    for (const band of QTY_BANDS) {
      expect(band.min).toBe(previousMax + 1);
      previousMax = band.max;
    }
    expect(previousMax).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("nearestRankQuantile", () => {
  it("returns actual sample values — never fractional cents", () => {
    expect(nearestRankQuantile([10, 20, 30, 40], 0.25)).toBe(10); // rank ⌈0.25·4⌉ = 1
    expect(nearestRankQuantile([10, 20, 30, 40], 0.5)).toBe(20); // rank ⌈0.5·4⌉ = 2
    expect(nearestRankQuantile([10, 20, 30, 40], 0.75)).toBe(30); // rank ⌈0.75·4⌉ = 3
  });

  it("handles single-element and unsorted inputs deterministically", () => {
    expect(nearestRankQuantile([42], 0.5)).toBe(42);
    expect(nearestRankQuantile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(nearestRankQuantile([], 0.5)).toBeNull();
  });

  it("rejects out-of-range p", () => {
    expect(() => nearestRankQuantile([1], 0)).toThrow();
    expect(() => nearestRankQuantile([1], 1.01)).toThrow();
  });
});

describe("aggregatePriceBenchmarks", () => {
  const K = 5;

  it("publishes exact fixture statistics for groups at or above k", () => {
    const rows = aggregatePriceBenchmarks(fixturePriceSamples(), K);
    const pet = rows.find((r) => r.material === "PET" && r.categoryId === FIXTURE_CATEGORY);
    const glass = rows.find((r) => r.material === "GLASS" && r.categoryId === FIXTURE_CATEGORY);
    expect(pet).toEqual({ categoryId: FIXTURE_CATEGORY, qtyBand: "1000-4999", material: "PET", ...FIXTURE_PET_STATS });
    expect(glass).toEqual({
      categoryId: FIXTURE_CATEGORY,
      qtyBand: "1000-4999",
      material: "GLASS",
      ...FIXTURE_GLASS_STATS,
    });
  });

  it("NEVER publishes a row for a group below k — the small group leaks nothing", () => {
    const rows = aggregatePriceBenchmarks(fixturePriceSamples(), K);
    expect(rows.some((r) => r.categoryId === FIXTURE_RARE_CATEGORY)).toBe(false);
    // And raising k hides formerly published groups too.
    expect(aggregatePriceBenchmarks(fixturePriceSamples(), 7)).toEqual([]);
  });

  it("publishes a group exactly AT k (boundary)", () => {
    const atThreshold = aggregatePriceBenchmarks(fixturePriceSamples(), 6);
    expect(atThreshold.map((r) => r.material)).toEqual(["GLASS", "PET"]);
  });

  it("is deterministic — same samples, same rows, same order", () => {
    expect(aggregatePriceBenchmarks(fixturePriceSamples(), K)).toEqual(
      aggregatePriceBenchmarks(fixturePriceSamples(), K),
    );
  });
});

describe("aggregateLeadTimeBenchmarks", () => {
  it("publishes exact lead-time statistics for groups at or above k", () => {
    const rows = aggregateLeadTimeBenchmarks(fixtureLeadTimeSamples(), 5);
    const pet = rows.find((r) => r.categoryId === FIXTURE_CATEGORY);
    expect(pet).toEqual({
      categoryId: FIXTURE_CATEGORY,
      qtyBand: "1000-4999",
      material: "PET",
      ...FIXTURE_PET_LEAD_STATS,
    });
  });

  it("never publishes the below-k rare group's lead times", () => {
    const rows = aggregateLeadTimeBenchmarks(fixtureLeadTimeSamples(), 5);
    expect(rows.some((r) => r.categoryId === FIXTURE_RARE_CATEGORY)).toBe(false);
  });
});
