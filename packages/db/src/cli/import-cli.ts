import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { importSuppliersCsv } from "../importer/importer";
import { buildMergeReportCsv } from "../importer/merge-report";
import { databaseUrl } from "../index";

/**
 * CLI: import supplier rows from a migration CSV.
 *
 *   pnpm --filter @packsource/db import -- --file <path.csv> [--report <path.csv>]
 *
 * Exit codes: 0 = clean import; 2 = imported with row-level errors (skipped
 * rows, unknown category slugs); 1 = fatal (file unreadable, contract
 * violation, DB failure). The merge report is written for every run that got
 * past header validation.
 */

function readArg(flag: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`--${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 3);
  const index = process.argv.indexOf(`--${flag}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}

async function main(): Promise<void> {
  const file = readArg("file");
  if (file === undefined || file === "") {
    console.error("Usage: import -- --file <path.csv> [--report <path.csv>]");
    process.exitCode = 1;
    return;
  }
  const reportPath = readArg("report") ?? "import-merge-report.csv";

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
    const summary = await importSuppliersCsv(client, csvText);
    writeFileSync(reportPath, buildMergeReportCsv(summary.decisions), "utf8");

    console.log(`Rows in file:          ${summary.inputRowCount}`);
    console.log(`Organizations created: ${summary.importedOrgCount}`);
    console.log(`Merged duplicates:     ${summary.mergedRowCount}`);
    console.log(`Flagged for review:    ${summary.reviewRowCount}`);
    console.log(`Row-level errors:      ${summary.errorRows.length}`);
    console.log(`Merge report:          ${reportPath}`);
    for (const rowError of summary.errorRows) {
      console.error(
        `  line ${rowError.lineNumber} (${rowError.column ?? "-"}): ${rowError.message}`,
      );
    }
    process.exitCode = summary.errorRows.length > 0 ? 2 : 0;
  } finally {
    await client.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
