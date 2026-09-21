/**
 * Deterministic benchmark fixtures (spec: "deterministic fixtures") — fixed
 * samples with hand-computable exact statistics, including groups that sit
 * below the k-threshold so tests can prove small groups never publish.
 * Used by unit tests and the demo/dogfood path; no randomness anywhere.
 */
import type { BenchmarkSample, LeadTimeSample } from "./core";
import { qtyBandFor } from "./core";

export const FIXTURE_CATEGORY = "cat_fixture_rigid";
/** A group with fewer than k=5 samples — must never surface a benchmark row. */
export const FIXTURE_RARE_CATEGORY = "cat_fixture_rare";

const PET_PRICES_CENTS: ReadonlyArray<[number, number]> = [
  // [quantity, unit price cents] — 6 samples in the 1000-4999 band (>= k).
  [1000, 18],
  [2000, 16],
  [2500, 15],
  [3000, 14],
  [4000, 12],
  [4500, 12],
];
/** Exact fixture stats for PET in 1000-4999 (nearest-rank over the 6 sorted prices 12,12,14,15,16,18). */
export const FIXTURE_PET_STATS = { sampleCount: 6, p25Cents: 12, medianCents: 14, p75Cents: 16 };

const GLASS_PRICES_CENTS: ReadonlyArray<[number, number]> = [
  [1200, 44],
  [1800, 41],
  [2200, 38],
  [3600, 36],
  [4100, 33],
  [4900, 31],
];
/** Exact fixture stats for GLASS in 1000-4999 (sorted 31,33,36,38,41,44). */
export const FIXTURE_GLASS_STATS = { sampleCount: 6, p25Cents: 33, medianCents: 36, p75Cents: 41 };

/** Four PET samples in a rare category — below k, must produce no row. */
const RARE_PRICES_CENTS: ReadonlyArray<[number, number]> = [
  [5000, 25],
  [6000, 24],
  [7000, 23],
  [8000, 22],
];

export function fixturePriceSamples(): BenchmarkSample[] {
  const samples: BenchmarkSample[] = [];
  for (const [qty, price] of PET_PRICES_CENTS) {
    samples.push({ categoryId: FIXTURE_CATEGORY, qtyBand: qtyBandFor(qty), material: "PET", unitPriceCents: price });
  }
  for (const [qty, price] of GLASS_PRICES_CENTS) {
    samples.push({ categoryId: FIXTURE_CATEGORY, qtyBand: qtyBandFor(qty), material: "GLASS", unitPriceCents: price });
  }
  for (const [qty, price] of RARE_PRICES_CENTS) {
    samples.push({
      categoryId: FIXTURE_RARE_CATEGORY,
      qtyBand: qtyBandFor(qty),
      material: "PET",
      unitPriceCents: price,
    });
  }
  return samples;
}

const PET_LEAD_DAYS: readonly number[] = [12, 14, 15, 15, 18, 21];
/** Exact fixture lead-time stats for PET in 1000-4999 (sorted 12,14,15,15,18,21). */
export const FIXTURE_PET_LEAD_STATS = { sampleCount: 6, p25Days: 14, medianDays: 15, p75Days: 18 };

/** Three lead-time samples in the rare category — below k, no row. */
const RARE_LEAD_DAYS: readonly number[] = [9, 10, 11];

export function fixtureLeadTimeSamples(): LeadTimeSample[] {
  const samples: LeadTimeSample[] = [];
  for (const [index, days] of PET_LEAD_DAYS.entries()) {
    const qty = 1000 + index * 500;
    samples.push({ categoryId: FIXTURE_CATEGORY, qtyBand: qtyBandFor(qty), material: "PET", leadTimeDays: days });
  }
  for (const [index, days] of RARE_LEAD_DAYS.entries()) {
    const qty = 5000 + index * 100;
    samples.push({
      categoryId: FIXTURE_RARE_CATEGORY,
      qtyBand: qtyBandFor(qty),
      material: "PET",
      leadTimeDays: days,
    });
  }
  return samples;
}
