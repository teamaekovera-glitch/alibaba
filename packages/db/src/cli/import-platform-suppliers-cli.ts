import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { databaseUrl } from "../index";
import {
  importPlatformSuppliersCsv,
  otherBucketSize,
  type PlatformImportSummary,
} from "../discovery/import";
import { DISCOVERY_CATEGORIES } from "../discovery/taxonomy";

/**
 * CLI: import the Platform Ready supplier directory CSV into PlatformSupplier.
 *
 *   pnpm --filter @packsource/db import-platform-suppliers [--file <path.csv>]
 *
 * Idempotent: rows upsert by slug, so re-running updates in place and creates
 * zero new rows. Prints the import report — rows processed, created/updated,
 * per-category counts, and the other-bucket size — which is the tuning dial
 * for the keyword rules in src/discovery/taxonomy.ts.
 *
 * Exit codes: 0 = clean import; 2 = imported with row-level errors; 1 = fatal.
 */

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_FIXTURE = path.join(
  pkgRoot,
  "fixtures",
  "platform-suppliers",
  "platform-ready-20260817.csv",
);

function readArg(flag: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`--${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 3);
  const index = process.argv.indexOf(`--${flag}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}

function printReport(summary: PlatformImportSummary): void {
  console.log(`Rows processed:        ${summary.inputRowCount}`);
  console.log(`Rows created:          ${summary.createdCount}`);
  console.log(`Rows updated:          ${summary.updatedCount}`);
  console.log(`Row-level errors:      ${summary.errorRows.length}`);
  console.log(`Other-bucket size:     ${otherBucketSize(summary)}`);
  console.log("Primary categories:");
  for (const category of DISCOVERY_CATEGORIES) {
    console.log(`  ${category.slug.padEnd(24)} ${summary.categoryCounts[category.slug] ?? 0}`);
  }
  for (const rowError of summary.errorRows) {
    console.error(`  line ${rowError.lineNumber}: ${rowError.message}`);
  }
}

async function main(): Promise<void> {
  const file = readArg("file") ?? DEFAULT_FIXTURE;

  // Validates DATABASE_URL up front with a helpful message (no connect yet).
  databaseUrl();

  let csvText: string;
  try {
    csvText = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const client = new PrismaClient();
  try {
    const summary = await importPlatformSuppliersCsv(client, csvText);
    printReport(summary);
    process.exitCode = summary.errorRows.length > 0 ? 2 : 0;
  } finally {
    await client.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
