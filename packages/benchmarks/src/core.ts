/**
 * Pure benchmark aggregation core (spec: analytics — "k-anonymous benchmarks:
 * median unit price and lead time by category × quantity band × material;
 * k ≥ 5 to publish"). No database, no clock, no randomness — the persisted
 * PriceBenchmark rows and the buyer-facing read API are both fed from these
 * functions so the k-threshold lives in exactly one place.
 *
 * Arithmetic contract: all money is integer cents; quantiles use the
 * nearest-rank method (the result is always an actual sample value, never a
 * fractional cent).
 */

/** Canonical quantity bands (schema: PriceBenchmark.qtyBand "canonical band
 * key, e.g. '1000-4999'"). The open-ended top band uses the "+" suffix. */
export const QTY_BANDS: ReadonlyArray<{ key: string; min: number; max: number }> = [
  { key: "1-999", min: 1, max: 999 },
  { key: "1000-4999", min: 1000, max: 4999 },
  { key: "5000-9999", min: 5000, max: 9999 },
  { key: "10000-24999", min: 10000, max: 24999 },
  { key: "25000-49999", min: 25000, max: 49999 },
  { key: "50000-99999", min: 50000, max: 99999 },
  { key: "100000+", min: 100000, max: Number.MAX_SAFE_INTEGER },
];

/** Raised when a quantity falls outside every canonical band (≤ 0). */
export class QuantityOutOfRangeError extends Error {
  constructor(
    message: string,
    readonly quantity: number,
  ) {
    super(message);
    this.name = "QuantityOutOfRangeError";
  }
}

/** The canonical band key for a quantity, e.g. 12,000 → "10000-24999". */
export function qtyBandFor(quantity: number): string {
  const band = QTY_BANDS.find((b) => quantity >= b.min && quantity <= b.max);
  if (!band) {
    throw new QuantityOutOfRangeError(`quantity ${quantity} falls outside every canonical band`, quantity);
  }
  return band.key;
}

/**
 * Nearest-rank quantile over integer samples. p ∈ (0, 1]; returns the value
 * at rank ⌈p·n⌉ of the ascending sort — always an actual sample, so cents
 * stay integers and the arithmetic is exact. Input need not be pre-sorted.
 */
export function nearestRankQuantile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p <= 0 || p > 1) throw new Error(`quantile p must be in (0, 1], got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

/** One observed data point in a benchmark group. */
export interface BenchmarkSample {
  categoryId: string;
  /** Canonical band key (see qtyBandFor). */
  qtyBand: string;
  material: string;
  /** Unit price in integer cents. */
  unitPriceCents: number;
}

/** One observed production lead time in a benchmark group. */
export interface LeadTimeSample {
  categoryId: string;
  qtyBand: string;
  material: string;
  leadTimeDays: number;
}

export interface PriceBenchmarkRow {
  categoryId: string;
  qtyBand: string;
  material: string;
  sampleCount: number;
  medianCents: number;
  p25Cents: number;
  p75Cents: number;
}

export interface LeadTimeBenchmarkRow {
  categoryId: string;
  qtyBand: string;
  material: string;
  sampleCount: number;
  medianDays: number;
  p25Days: number;
  p75Days: number;
}

/** Groups rows by (categoryId, qtyBand, material) in stable sorted-key order. */
function groupSamples<T extends { categoryId: string; qtyBand: string; material: string }>(
  samples: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const sample of samples) {
    const key = `${sample.categoryId}|${sample.qtyBand}|${sample.material}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(sample);
    } else {
      groups.set(key, [sample]);
    }
  }
  return groups;
}

/**
 * Aggregates price samples into k-anonymous benchmark rows. Groups with
 * fewer than `minGroupSize` observations return NO row — the hard
 * k-threshold; a small group can never leak member prices. Groups are
 * returned sorted by (categoryId, qtyBand, material) for determinism.
 */
export function aggregatePriceBenchmarks(samples: BenchmarkSample[], minGroupSize: number): PriceBenchmarkRow[] {
  if (minGroupSize < 1) throw new Error(`minGroupSize must be >= 1, got ${minGroupSize}`);
  const rows: PriceBenchmarkRow[] = [];
  for (const [key, group] of [...groupSamples(samples).entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length < minGroupSize) continue;
    const prices = group.map((s) => s.unitPriceCents);
    const [categoryId, qtyBand, material] = key.split("|") as [string, string, string];
    rows.push({
      categoryId,
      qtyBand,
      material,
      sampleCount: group.length,
      p25Cents: nearestRankQuantile(prices, 0.25) as number,
      medianCents: nearestRankQuantile(prices, 0.5) as number,
      p75Cents: nearestRankQuantile(prices, 0.75) as number,
    });
  }
  return rows;
}

/**
 * Aggregates lead-time samples into k-anonymous rows under the same
 * threshold and determinism rules as the price aggregation.
 */
export function aggregateLeadTimeBenchmarks(samples: LeadTimeSample[], minGroupSize: number): LeadTimeBenchmarkRow[] {
  if (minGroupSize < 1) throw new Error(`minGroupSize must be >= 1, got ${minGroupSize}`);
  const rows: LeadTimeBenchmarkRow[] = [];
  for (const [key, group] of [...groupSamples(samples).entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length < minGroupSize) continue;
    const days = group.map((s) => s.leadTimeDays);
    const [categoryId, qtyBand, material] = key.split("|") as [string, string, string];
    rows.push({
      categoryId,
      qtyBand,
      material,
      sampleCount: group.length,
      p25Days: nearestRankQuantile(days, 0.25) as number,
      medianDays: nearestRankQuantile(days, 0.5) as number,
      p75Days: nearestRankQuantile(days, 0.75) as number,
    });
  }
  return rows;
}
