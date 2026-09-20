/**
 * Faceted listing search: the spec's discovery stack behind one interface —
 * deterministic in-memory mock (default), Meilisearch adapter, pgvector
 * semantic + hybrid ranking, visual search, and the Postgres outage fallback.
 */

export * from "./types";
export * from "./facets";
export * from "./listing-graph";
export * from "./index-sync";
export * from "./filtering";
export * from "./ordering";
export * from "./mock-faceted-search";
export * from "./meilisearch-adapter";
export * from "./create-search";
export * from "./postgres-fallback";
export * from "./discovery";
export * from "./semantic";
export * from "./visual";
