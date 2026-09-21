/**
 * Platform Ready directory import: maps CSV rows (readPlatformSupplierRows)
 * and upserts them by slug in transactional batches. Re-running never
 * duplicates — existing slugs are updated in place, which is what makes the
 * "second run creates zero new rows" acceptance check pass.
 */

import type { PrismaClient } from "@prisma/client";
import { readPlatformSupplierRows, type PlatformRowError } from "./import-rows";
import { OTHER_GENERAL_SLUG } from "./taxonomy";

export interface PlatformImportOptions {
  /** Rows per transaction; the default batches 250 upserts. */
  batchSize?: number;
}

export interface PlatformImportSummary {
  /** Classified rows read from the CSV (errors excluded). */
  inputRowCount: number;
  /** Slugs that did not exist before this run (fresh inserts). */
  createdCount: number;
  /** Slugs that already existed and were updated in place. */
  updatedCount: number;
  /** Rows skipped with reasons (missing company name, bad header, …). */
  errorRows: PlatformRowError[];
  /** Primary-category assignment counts from this run's rows. */
  categoryCounts: Record<string, number>;
}

export async function importPlatformSuppliersCsv(
  client: PrismaClient,
  csvText: string,
  options?: PlatformImportOptions,
): Promise<PlatformImportSummary> {
  const batchSize = options?.batchSize ?? 250;
  const { rows, errors } = readPlatformSupplierRows(csvText);

  // Existing slugs decide created vs updated accounting (not upsert return
  // values, which do not distinguish the two).
  const existing = new Set<string>(
    (await client.platformSupplier.findMany({ select: { slug: true } })).map((r) => r.slug),
  );

  let createdCount = 0;
  let updatedCount = 0;
  const categoryCounts: Record<string, number> = {};

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    await client.$transaction(async (tx) => {
      for (const row of batch) {
        await tx.platformSupplier.upsert({
          where: { slug: row.slug },
          create: row,
          update: row,
        });
      }
    });
    for (const row of batch) {
      if (existing.has(row.slug)) updatedCount += 1;
      else createdCount += 1;
      categoryCounts[row.primaryCategory] = (categoryCounts[row.primaryCategory] ?? 0) + 1;
    }
  }

  return {
    inputRowCount: rows.length,
    createdCount,
    updatedCount,
    errorRows: errors,
    categoryCounts,
  };
}

/** Other & General bucket size — the "every record reachable" fallback count. */
export function otherBucketSize(summary: PlatformImportSummary): number {
  return summary.categoryCounts[OTHER_GENERAL_SLUG] ?? 0;
}
