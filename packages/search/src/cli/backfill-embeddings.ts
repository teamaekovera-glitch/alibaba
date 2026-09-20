/**
 * CLI: batch backfill of pgvector TITLE embeddings for all LIVE listings.
 *
 * Usage (deterministic mock embeddings; zero API keys):
 *   DATABASE_URL=postgres://... pnpm --filter @packsource/search backfill:embeddings
 *   [--batch-size=100] [--limit=500] [--overwrite]
 */
import { createAdapters } from "@packsource/ai";
import { PrismaClient } from "@packsource/db";
import { backfillListingEmbeddings } from "../semantic";

function intOption(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return undefined;
  const value = Number(raw.split("=")[1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (e.g. postgres://localhost:5432/packsource)");
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const embedding = createAdapters().embedding;
    const result = await backfillListingEmbeddings(prisma, embedding, {
      batchSize: intOption("batch-size") ?? 100,
      limit: intOption("limit"),
      overwrite: process.argv.includes("--overwrite"),
    });
    console.log(
      `backfill complete: processed=${result.processed} skipped=${result.skipped} ` +
        `model=${result.model} dimensions=${result.dimensions}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
