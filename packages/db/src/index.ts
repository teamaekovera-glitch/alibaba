/**
 * Database package. Prisma schema + migrations, the nine-category packaging
 * taxonomy with its attribute-set dialect, and the Zod validators derived from
 * those attribute sets.
 */
export const DATABASE_URL_ENV = "DATABASE_URL" as const;

export function databaseUrl(): string {
  const url = process.env[DATABASE_URL_ENV];
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — copy .env.example to .env and run docker compose up -d db.",
    );
  }
  return url;
}

export * from "./taxonomy/types";
export * from "./taxonomy/categories";
export * from "./attribute-validation";
export * from "./client";
