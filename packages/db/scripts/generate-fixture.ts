/**
 * Generates the committed importer fixture CSV:
 * fixtures/importer/sample-500.csv — 500 data rows over 490 distinct
 * companies plus 10 engineered near-duplicates (cosmetic name / formatting
 * variants that the dedup scorer must merge).
 *
 * Fully deterministic via index arithmetic — no RNG, so regenerating the
 * fixture produces a byte-identical file.
 *
 * Run: pnpm --filter @packsource/db fixtures:importer
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { flattenTaxonomy } from "../src/taxonomy/categories";

const ROOTS = [
  "Summit", "Crestline", "Orion", "Harborview", "Meridian", "Lakeshore", "Vanguard",
  "Pinnacle", "Bluegrass", "Copperfield", "Stonebridge", "Fairwind", "Northstar",
  "Redstone", "Silvercreek", "Trueline", "Waypoint", "Juniper", "Cascadia", "Dunmore",
  "Elmwood", "Foxfield", "Glenview", "Hartwell", "Ironwood", "Kestrel", "Longleaf",
  "Maplewood", "Newbury", "Oakfield", "Pinehurst", "Quarryhill", "Riverbend", "Sagebrush",
  "Thornbury", "Ulster", "Vinebrook", "Westgate", "Yarrow", "Ashford", "Briarcliff",
  "Cedarville", "Dovercourt", "Eastbrook", "Fernhill", "Grandview", "Holloway", "Inglewood",
  "Jamestown", "Kingsport", "Larkspur", "Montclair", "Norwood", "Oakhurst", "Parkside",
  "Quinby", "Ridgefield", "Selma", "Tiburon", "Upton", "Valleymount", "Wexford",
  "Yorkville", "Zionsville", "Amberly", "Bellhaven", "Collinswood", "Drayton", "Ellsworth",
  "Fenwick",
] as const;

const SUFFIXES = [
  "Packaging",
  "Container Co.",
  "Plastics",
  "Converting",
  "Pack Corp.",
  "Group",
  "Solutions",
] as const;

const CITIES: { city: string; state: string }[] = [
  { city: "Chicago", state: "IL" }, { city: "Dallas", state: "TX" },
  { city: "Atlanta", state: "GA" }, { city: "Denver", state: "CO" },
  { city: "Portland", state: "OR" }, { city: "Nashville", state: "TN" },
  { city: "Charlotte", state: "NC" }, { city: "Columbus", state: "OH" },
  { city: "Phoenix", state: "AZ" }, { city: "Kansas City", state: "MO" },
  { city: "Milwaukee", state: "WI" }, { city: "Raleigh", state: "NC" },
  { city: "Omaha", state: "NE" }, { city: "Tulsa", state: "OK" },
  { city: "Fresno", state: "CA" }, { city: "Sacramento", state: "CA" },
  { city: "Louisville", state: "KY" }, { city: "Birmingham", state: "AL" },
  { city: "Richmond", state: "VA" }, { city: "Salt Lake City", state: "UT" },
  { city: "Indianapolis", state: "IN" }, { city: "Pittsburgh", state: "PA" },
  { city: "Cleveland", state: "OH" }, { city: "Minneapolis", state: "MN" },
  { city: "St. Louis", state: "MO" }, { city: "Hartford", state: "CT" },
  { city: "Grand Rapids", state: "MI" }, { city: "Des Moines", state: "IA" },
  { city: "Boise", state: "ID" }, { city: "Little Rock", state: "AR" },
  { city: "Knoxville", state: "TN" }, { city: "Wichita", state: "KS" },
  { city: "Providence", state: "RI" }, { city: "Buffalo", state: "NY" },
  { city: "Akron", state: "OH" }, { city: "Toledo", state: "OH" },
  { city: "Green Bay", state: "WI" }, { city: "Chattanooga", state: "TN" },
  { city: "Spokane", state: "WA" }, { city: "Albany", state: "NY" },
] as const;

const CERTIFICATIONS = ["SQF", "BRCGS", "FDA_REGISTRATION", "ORGANIC"] as const;

const EXPECTED_UNIQUE_COMPANIES = 490;
const DUPLICATE_TARGETS = [0, 6, 30, 60, 90, 120, 150, 180, 210, 240];

// Bank lookups with explicit guards — noUncheckedIndexedAccess makes every
// index read `T | undefined`, and generation must fail loudly, not silently.
function rootAt(i: number): string {
  const value = ROOTS[i % ROOTS.length];
  if (value === undefined) throw new Error(`root bank underflow at ${i}`);
  return value;
}
function suffixAt(i: number): string {
  const value = SUFFIXES[Math.floor(i / ROOTS.length) % SUFFIXES.length];
  if (value === undefined) throw new Error(`suffix bank underflow at ${i}`);
  return value;
}
function placeAt(i: number): { city: string; state: string } {
  const value = CITIES[i % CITIES.length];
  if (value === undefined) throw new Error(`city bank underflow at ${i}`);
  return value;
}
function certAt(i: number): string {
  const value = CERTIFICATIONS[Math.floor(i / CERTIFICATIONS.length) % CERTIFICATIONS.length];
  if (value === undefined) throw new Error("cert bank underflow");
  return value;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface FixtureRow {
  name: string;
  city: string;
  state: string;
  country: string;
  email: string | null;
  phone: string | null;
  domain: string | null;
  categories: string[];
  certifications: string[];
  about: string | null;
}

function baseRows(): FixtureRow[] {
  const allSlugs = flattenTaxonomy().map((entry) => entry.slug);
  const slugAt = (i: number): string => {
    const value = allSlugs[i % allSlugs.length];
    if (value === undefined) throw new Error(`taxonomy slug underflow at ${i}`);
    return value;
  };
  const rows: FixtureRow[] = [];

  if (ROOTS.length * SUFFIXES.length < EXPECTED_UNIQUE_COMPANIES) {
    throw new Error(
      `name bank too small: ${ROOTS.length} x ${SUFFIXES.length} < ${EXPECTED_UNIQUE_COMPANIES}`,
    );
  }

  for (let i = 0; i < EXPECTED_UNIQUE_COMPANIES; i += 1) {
    const root = rootAt(i);
    const suffix = suffixAt(i);
    const name = `${root} ${suffix}`;
    const place = placeAt(i);
    const domain = `${slugify(`${root}-${suffix.split(" ")[0] ?? suffix}`)}.example`;
    const phoneSuffix = String(2000 + i); // unique last-4 per row; 555/010x = fictional range
    const phone =
      i % 3 === 0
        ? `(555) 010-${phoneSuffix}`
        : i % 3 === 1
          ? `555.010.${phoneSuffix}`
          : `+1 555-010-${phoneSuffix}`;

    const categories = [slugAt(i)];
    if (i % 3 === 0) {
      const extra = slugAt((i * 7) % allSlugs.length);
      if (!categories.includes(extra)) categories.push(extra);
    }

    rows.push({
      name,
      city: place.city,
      state: i % 9 === 0 ? "" : place.state,
      country: "US",
      email: i % 6 === 0 ? null : `sales@${domain}`,
      phone,
      domain: i % 11 === 0 ? null : domain,
      categories,
      certifications: i % 4 === 0 ? [certAt(i)] : [],
      about: i % 5 === 0 ? `Family-owned ${root.toLowerCase()} converter serving the Midwest.` : null,
    });
  }
  return rows;
}

/** Cosmetic near-duplicates: names normalize identically, city matches, domain matches. */
function duplicateRows(base: FixtureRow[]): FixtureRow[] {
  return DUPLICATE_TARGETS.map((targetIndex, k) => {
    const original = base[targetIndex];
    if (original === undefined) throw new Error(`no fixture row at index ${targetIndex}`);
    const variant = k % 4;
    let name: string;
    switch (variant) {
      case 0:
        name = `${original.name} Inc.`;
        break;
      case 1:
        name = `${original.name} Co.`;
        break;
      case 2:
        name = original.name.toUpperCase();
        break;
      default:
        name = `${original.name} LLC.`;
    }
    return {
      ...original,
      name,
      city: variant === 2 ? original.city.toUpperCase() : original.city,
      domain: variant === 1 ? `www.${original.domain ?? ""}` : original.domain,
      // Duplicate supplies an email for originals that lack one (tests backfill).
      email: original.email === null ? `sales@${original.domain ?? "example.invalid"}` : null,
      categories: [],
      certifications: [],
      about: null,
    };
  });
}

function csvField(value: string | null): string {
  const raw = value ?? "";
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function toCsv(rows: FixtureRow[]): string {
  const header = [
    "name", "city", "state", "country", "email", "phone", "domain",
    "categories", "certifications", "about",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.name), csvField(row.city), csvField(row.state), csvField(row.country),
        csvField(row.email), csvField(row.phone), csvField(row.domain),
        csvField(row.categories.join(";")), csvField(row.certifications.join(";")),
        csvField(row.about),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

const fixtureDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "fixtures/importer");
mkdirSync(fixtureDir, { recursive: true });
writeFileSync(
  path.join(fixtureDir, "sample-500.csv"),
  toCsv([...baseRows(), ...duplicateRows(baseRows())]),
  "utf8",
);
console.log("Wrote fixtures/importer/sample-500.csv (500 data rows, 10 engineered near-duplicates)");
