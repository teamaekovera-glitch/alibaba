/**
 * Database package shell. The Prisma client singleton, migrations, seed, and
 * CSV importer CLI arrive with the schema workstream; the scaffold pins the
 * datasource contract only.
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
