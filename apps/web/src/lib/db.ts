import { PrismaClient } from "@packsource/db";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — copy packages/db/.env.example and run docker compose up -d db.",
    );
  }
  return url;
}

function instantiateClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
}

/**
 * One PrismaClient per process — Next.js hot reloads would otherwise open a
 * connection pool per module evaluation.
 *
 * Instantiation is lazy (first property access), not eager: `next build`
 * imports every route module to collect page data, and the build environment
 * is intentionally DB-less — an eager throw there fails the build instead of
 * surfacing at the first real query.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!globalForPrisma.prisma) {
      globalForPrisma.prisma = instantiateClient();
    }
    const client = globalForPrisma.prisma;
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
