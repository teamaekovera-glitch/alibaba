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
export * from "./importer/column-contract";
export * from "./importer/normalize";
export * from "./importer/similarity";
export * from "./importer/parse-csv";
export * from "./importer/dedup";
export * from "./importer/read-rows";
export * from "./importer/merge-report";
export * from "./importer/types";
export * from "./importer/importer";
export * from "./seed/rng";
export * from "./seed/attributes";
export * from "./seed/images";
export * from "./seed/names";
export * from "./seed/seed";
export * from "./seed/demo";
export * from "./client";
