/** FNV-1a 32-bit hash — deterministic fingerprint used by the mocks
 * (embedding vectors, vision input hashes). Never for security. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fnv1aHex(input: string): string {
  return `fnv1a:${fnv1a(input).toString(16).padStart(8, "0")}`;
}

/** Deterministic pseudo-value in [0, 1) derived from input and an axis. */
export function hashToUnit(input: string, axis: number): number {
  return (fnv1a(`${input}:${axis}`) % 10000) / 10000;
}
