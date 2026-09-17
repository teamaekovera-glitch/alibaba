import { PrismaClient } from "@packsource/db";

/**
 * One PrismaClient per process — Next.js hot reloads would otherwise open a
 * connection pool per module evaluation.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient({ datasources: { db: { url: databaseUrl() } } });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — copy packages/db/.env.example and run docker compose up -d db.",
    );
  }
  return url;
}
