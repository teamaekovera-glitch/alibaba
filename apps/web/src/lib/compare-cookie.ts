/**
 * Compare-selection state: a plain cookie (`packsource_compare`) holding up to
 * four listing slugs, shared by every buyer surface. Server components read it
 * to render /compare; the client button toggles it. Pure helpers are unit
 * tested; Next's cookies() API stays at the edge of the app.
 */

export const COMPARE_COOKIE = "packsource_compare";

/** The compare tray holds at most 4 listings (spec §compare). */
export const COMPARE_LIMIT = 4;

/** Parse the cookie value into unique slugs, capped at the limit, order kept. */
export function parseCompareSlugs(value: string | undefined | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").filter(Boolean))].slice(0, COMPARE_LIMIT);
}

/** Serialize slugs for the cookie; throws when over the limit (callers must
 * toggle, never bulk-write past the cap). */
export function serializeCompareSlugs(slugs: string[]): string {
  const unique = [...new Set(slugs)];
  if (unique.length > COMPARE_LIMIT) {
    throw new Error(`compare tray holds at most ${COMPARE_LIMIT} listings`);
  }
  return unique.join(",");
}

/** Toggle a slug in a selection, honoring the cap: adding to a full tray is a
 * no-op so the UI can message "full" instead of silently dropping. */
export function toggledCompareSlugs(slugs: string[], slug: string): string[] {
  if (slugs.includes(slug)) {
    return slugs.filter((entry) => entry !== slug);
  }
  if (slugs.length >= COMPARE_LIMIT) {
    return slugs;
  }
  return [...slugs, slug];
}
