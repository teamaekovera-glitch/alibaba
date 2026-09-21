/**
 * Deterministic visuals for the discovery directory (spec: offline-safe
 * imagery). Platform Ready records ship with no photos, so supplier cards
 * render initials avatars tinted by the record's primary category — no
 * external image fetches, stable across renders and reloads.
 */

/** 32-bit FNV-1a hash — one rotation round, deterministic across processes. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Up to two leading initials, e.g. "Flatlands Processing" → "FP". */
export function initialsFor(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

/** One gradient per category slug (Tailwind literals — no interpolation, so the JIT keeps them). */
const CATEGORY_TINTS: Record<string, string> = {
  dairy: "from-sky-100 via-blue-50 to-indigo-100",
  beverages: "from-cyan-100 via-teal-50 to-sky-100",
  "coffee-tea": "from-amber-100 via-orange-50 to-rose-100",
  bakery: "from-amber-100 via-yellow-50 to-orange-100",
  "meat-poultry": "from-rose-100 via-red-50 to-orange-100",
  seafood: "from-sky-100 via-cyan-50 to-teal-100",
  produce: "from-lime-100 via-green-50 to-emerald-100",
  "snacks-sweets": "from-pink-100 via-fuchsia-50 to-rose-100",
  "sauces-seasonings": "from-orange-100 via-amber-50 to-red-100",
  "prepared-canned": "from-stone-100 via-neutral-50 to-zinc-100",
  "grains-baking": "from-yellow-100 via-amber-50 to-stone-100",
  "nutrients-supplements": "from-emerald-100 via-teal-50 to-cyan-100",
  "pet-food": "from-orange-100 via-stone-50 to-amber-100",
  "health-beauty": "from-fuchsia-100 via-pink-50 to-violet-100",
  "packaging-services": "from-violet-100 via-indigo-50 to-blue-100",
  "other-general": "from-neutral-100 via-slate-50 to-gray-100",
};

const NEUTRAL_TINT = "from-neutral-100 via-slate-50 to-gray-100";

/** Avatar gradient for a supplier: its category's tint, rotated by fnv1a(name) — deterministic. */
export function avatarGradient(categorySlug: string, name: string): string {
  const tint = CATEGORY_TINTS[categorySlug] ?? NEUTRAL_TINT;
  // Three gradient angles per tint so same-category cards vary without
  // breaking the palette; hash-modulo keeps it stable for a given name.
  const angles = ["bg-gradient-to-br", "bg-gradient-to-b", "bg-gradient-to-r"];
  const angle = angles[fnv1a(name) % angles.length];
  return `${angle} ${tint}`;
}

/** Card-header gradient pair for a category slug (category grid + page banners). */
export function categoryTint(categorySlug: string): string {
  return CATEGORY_TINTS[categorySlug] ?? NEUTRAL_TINT;
}
