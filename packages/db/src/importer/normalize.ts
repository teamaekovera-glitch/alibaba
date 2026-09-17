/**
 * Normalization for dedup signals. Pure functions — all comparisons in the
 * dedup scorer operate on these normalized forms so "Acme Pack Co." and
 * "ACME PACK COMPANY" collapse to the same key.
 */

/** Legal / incorporation suffixes stripped before name comparison. */
const NAME_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "co",
  "company",
  "corp",
  "corporation",
  "plc",
  "gmbh",
  "ag",
  "srl",
  "sro",
  "bv",
  "nv",
  "pty",
  "pvt",
  "sa",
  "sas",
  "kg",
  "oy",
  "ab",
  "as",
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalized company name: lowercase, punctuation removed, legal suffixes
 * dropped, whitespace collapsed. "Acme Pack Co." -> "acme pack".
 */
export function normalizeCompanyName(name: string): string {
  const stripped = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, " ")
    .split(/\s+/)
    .filter((token) => token !== "")
    .filter((token, index, tokens) => !(index === tokens.length - 1 && NAME_SUFFIXES.has(token)));
  return stripped.join(" ").trim();
}

/** Normalized city: lowercase, punctuation removed, whitespace collapsed. */
export function normalizeCity(city: string): string {
  return collapseWhitespace(city.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " "));
}

/**
 * Normalized domain: lowercase, protocol / path / port stripped, leading
 * "www." removed. Returns null for empty input. The TLD is kept —
 * "acme.com" and "acme.co" are different registrations.
 */
export function normalizeDomain(domain: string | null | undefined): string | null {
  if (domain === null || domain === undefined) return null;
  let value = collapseWhitespace(domain.toLowerCase());
  if (value === "") return null;
  value = value.replace(/^https?:\/\//, "").replace(/^\/+/, "");
  value = value.replace(/^www\./, "");
  // Cut any path or port after the host.
  const hostMatch = value.match(/^([^/?#:]+)/);
  const host = hostMatch?.[1] ?? value;
  return host === "" ? null : host;
}

/**
 * Phone match key: digits only. When more than 10 digits are present, the
 * last 10 are kept (drops country codes for NANP-style numbers). Requires at
 * least 7 digits to be usable as a signal.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

/** URL-safe slug from a raw value (company name, city) for slug construction. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
