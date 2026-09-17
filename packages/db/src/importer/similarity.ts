/**
 * Jaro-Winkler string similarity (0..1), implemented locally so the dedup
 * scorer has no third-party dependencies and stays deterministic.
 *
 * Standard parameters: Jaro similarity with a Winkler prefix bonus of
 * scale 0.1 for up to 4 shared leading characters, applied when the Jaro
 * similarity is above the standard 0.7 boost threshold.
 */

function jaro(first: string, second: string): number {
  if (first.length === 0 && second.length === 0) return 1;
  if (first.length === 0 || second.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(first.length, second.length) / 2) - 1);
  const firstMatches = new Array<boolean>(first.length).fill(false);
  const secondMatches = new Array<boolean>(second.length).fill(false);

  let matches = 0;
  for (let i = 0; i < first.length; i += 1) {
    const windowStart = Math.max(0, i - matchWindow);
    const windowEnd = Math.min(i + matchWindow + 1, second.length);
    for (let j = windowStart; j < windowEnd; j += 1) {
      if (secondMatches[j]) continue;
      if (first[i] !== second[j]) continue;
      firstMatches[i] = true;
      secondMatches[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions (paired matches in different order).
  let transpositions = 0;
  let secondIndex = 0;
  for (let i = 0; i < first.length; i += 1) {
    if (!firstMatches[i]) continue;
    while (!secondMatches[secondIndex]) secondIndex += 1;
    if (first[i] !== second[secondIndex]) transpositions += 1;
    secondIndex += 1;
  }
  transpositions = Math.floor(transpositions / 2);

  const m = matches;
  return (m / first.length + m / second.length + (m - transpositions) / m) / 3;
}

export function jaroWinkler(first: string, second: string): number {
  const similarity = jaro(first, second);
  if (similarity < 0.7) return similarity;

  let prefixLength = 0;
  const maxPrefix = Math.min(4, first.length, second.length);
  while (prefixLength < maxPrefix && first[prefixLength] === second[prefixLength]) {
    prefixLength += 1;
  }
  return similarity + prefixLength * 0.1 * (1 - similarity);
}
