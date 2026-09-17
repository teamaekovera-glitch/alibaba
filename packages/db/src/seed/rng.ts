/**
 * Deterministic PRNG (mulberry32) for the fictional seed. Same seed → same
 * stream on every machine, so seeded content is byte-identical across runs
 * (seed spec: rerunning the seed yields identical IDs and content).
 */

export type SeedRng = () => number;

export function mulberry32(seed: number): SeedRng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max] inclusive. */
export function intBetween(rng: SeedRng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Deterministic element pick. Requires a non-empty array (throws otherwise). */
export function pick<T>(rng: SeedRng, values: readonly T[]): T {
  const value = values[Math.floor(rng() * values.length)];
  if (value === undefined) throw new Error("pick called with an empty array");
  return value;
}

/** Weighted pick from a fixed probability table that sums to 1. */
export function weighted<T>(rng: SeedRng, entries: readonly { value: T; weight: number }[]): T {
  let roll = rng();
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry.value;
  }
  const last = entries[entries.length - 1];
  if (last === undefined) throw new Error("weighted called with an empty table");
  return last.value;
}
