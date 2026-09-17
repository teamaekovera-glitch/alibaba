import { PrismaClient } from "@prisma/client";
import { seedDatabase } from "../seed/seed";
import { databaseUrl } from "../index";

/**
 * CLI: deterministic fictional seed.
 *
 *   pnpm --filter @packsource/db seed
 *
 * Safe to rerun: wipes previous seed_* rows and recreates identical ones
 * (fixed ids + deterministic content).
 */
async function main(): Promise<void> {
  databaseUrl();
  const client = new PrismaClient();
  try {
    const summary = await seedDatabase(client);
    console.log("Seed complete (all rows fictional):");
    for (const [key, value] of Object.entries(summary)) {
      console.log(`  ${key.padEnd(16)} ${value}`);
    }
  } finally {
    await client.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
