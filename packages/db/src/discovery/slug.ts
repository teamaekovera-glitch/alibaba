/**
 * Deterministic slug construction for directory records. Slugs come from the
 * company name with legal suffixes stripped (the importer's own name
 * normalizer), deduped with state, then an ordinal — re-running the import
 * processes rows in the same file order, so the same record always earns the
 * same slug and upserts by slug stay idempotent.
 */

import { normalizeCompanyName, slugify } from "../importer/normalize";

/**
 * Slug for a supplier: "flatlands-processing" for "Flatlands Processing LLC".
 * When `taken` already holds the base slug, the state breaks the tie
 * ("acme-foods-tx"); a same-name-same-state collision appends an ordinal.
 */
export function supplierSlug(
  name: string,
  state: string | null | undefined,
  taken: ReadonlySet<string>,
): string {
  const base = slugify(normalizeCompanyName(name)) || "supplier";

  let candidate = base;
  if (taken.has(candidate)) {
    const statePart = (state ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (statePart !== "") {
      candidate = `${base}-${statePart}`;
    }
    let ordinal = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${ordinal}`;
      ordinal += 1;
    }
  }

  return candidate;
}
