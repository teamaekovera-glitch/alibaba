/**
 * Materialized price benchmarks + buyer-facing benchmark reads.
 *
 * - `recomputePriceBenchmarks` materializes the pure core's price rows into
 *   the schema's PriceBenchmark table (full deterministic refresh — seed
 *   scale is a few thousand samples; a scheduled job can call this later).
 * - `getPriceBenchmarks` / `getLeadTimeBenchmarks` are the buyer-facing read
 *   path: the price leg reads materialized rows and RE-enforces the
 *   k-threshold (a row under k must never surface, even if a bad write
 *   slipped past the aggregate), the lead-time leg computes live from order
 *   samples (no persistence model exists for it).
 */
import type { PrismaClient } from "@packsource/db";
import type { LeadTimeBenchmarkRow, LeadTimeSample, PriceBenchmarkRow } from "./core";
import { aggregateLeadTimeBenchmarks, aggregatePriceBenchmarks } from "./core";
import { loadLeadTimeSamples, loadPriceSamples } from "./sources";

/** Spec-locked k-anonymity threshold: groups below 5 samples never publish. */
export const K_ANONYMITY_MIN = 5;

export interface BenchmarkFilters {
  categoryId?: string;
  qtyBand?: string;
  material?: string;
}

export interface BenchmarkReadOptions {
  /** Override the k-threshold (tests use small synthetic k values). */
  minGroupSize?: number;
}

/**
 * Full deterministic refresh of the materialized PriceBenchmark table from
 * live-listing samples. Groups under k produce no row (enforced by the
 * aggregate core). Returns the number of published rows.
 */
export async function recomputePriceBenchmarks(
  db: PrismaClient,
  options: BenchmarkReadOptions = {},
): Promise<number> {
  const minGroupSize = options.minGroupSize ?? K_ANONYMITY_MIN;
  const samples = await loadPriceSamples(db);
  const rows = aggregatePriceBenchmarks(samples, minGroupSize);

  await db.$transaction(async (tx) => {
    await tx.priceBenchmark.deleteMany();
    if (rows.length > 0) {
      await tx.priceBenchmark.createMany({
        data: rows.map((row) => ({
          categoryId: row.categoryId,
          qtyBand: row.qtyBand,
          material: row.material,
          sampleCount: row.sampleCount,
          medianCents: row.medianCents,
          p25Cents: row.p25Cents,
          p75Cents: row.p75Cents,
        })),
      });
    }
  });
  return rows.length;
}

function belowThreshold(row: { sampleCount: number }, minGroupSize: number): boolean {
  return row.sampleCount < minGroupSize;
}

/**
 * Buyer-facing price benchmark read over the materialized rows. The
 * k-threshold is re-enforced here so no write path can ever leak a
 * below-threshold group through this API.
 */
export async function getPriceBenchmarks(
  db: PrismaClient,
  filters: BenchmarkFilters = {},
  options: BenchmarkReadOptions = {},
): Promise<PriceBenchmarkRow[]> {
  const minGroupSize = options.minGroupSize ?? K_ANONYMITY_MIN;
  const rows = await db.priceBenchmark.findMany({
    where: {
      categoryId: filters.categoryId,
      qtyBand: filters.qtyBand,
      material: filters.material,
    },
    select: {
      categoryId: true,
      qtyBand: true,
      material: true,
      sampleCount: true,
      medianCents: true,
      p25Cents: true,
      p75Cents: true,
    },
    orderBy: [{ categoryId: "asc" }, { qtyBand: "asc" }, { material: "asc" }],
  });
  return rows.filter((row) => !belowThreshold(row, minGroupSize));
}

/**
 * Buyer-facing lead-time benchmark read, computed live from placed orders
 * under the same k-threshold. Lead time has no materialized model, so the
 * aggregation runs per request — seed scale makes this cheap, and the same
 * pure core guarantees identical threshold behavior to the price leg.
 */
export async function getLeadTimeBenchmarks(
  db: PrismaClient,
  filters: BenchmarkFilters = {},
  options: BenchmarkReadOptions = {},
): Promise<LeadTimeBenchmarkRow[]> {
  const minGroupSize = options.minGroupSize ?? K_ANONYMITY_MIN;
  const samples: LeadTimeSample[] = await loadLeadTimeSamples(db);
  const filtered = samples.filter(
    (s) =>
      (filters.categoryId === undefined || s.categoryId === filters.categoryId) &&
      (filters.qtyBand === undefined || s.qtyBand === filters.qtyBand) &&
      (filters.material === undefined || s.material === filters.material),
  );
  return aggregateLeadTimeBenchmarks(filtered, minGroupSize);
}
