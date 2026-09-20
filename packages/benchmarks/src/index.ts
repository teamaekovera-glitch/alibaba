/**
 * K-anonymous benchmarks (spec: analytics — "median unit price and lead time
 * by category × quantity band × material; k ≥ 5 to publish"). Pure core for
 * aggregation and the k-threshold, DB loaders for the seeded sample sources,
 * materialized PriceBenchmark recompute, and buyer-facing reads.
 */
export * from "./core";
export * from "./sources";
export * from "./store";
export * from "./fixtures";
