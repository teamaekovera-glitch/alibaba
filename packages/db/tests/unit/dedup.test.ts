import { describe, expect, it } from "vitest";
import { listingTitle } from "../../src/seed/names";
import {
  TOP_LEVEL_CATEGORY_SLUGS,
  assertTopLevelSlugKeys,
} from "../../src/taxonomy/categories";
import {
  blockingKeys,
  decideDedup,
  fingerprintRow,
  MERGE_THRESHOLD,
  NAME_MERGE_FLOOR,
  REVIEW_THRESHOLD,
  scorePair,
  type DedupFingerprint,
} from "../../src/index";

/**
 * Dedup scoring unit tests (spec: Data Migration → importer contract).
 *
 * The decision is the conjunction of a weighted score and a name-similarity
 * floor: MERGE requires score >= MERGE_THRESHOLD AND nameSimilarity >=
 * NAME_MERGE_FLOOR; REVIEW covers the band down to REVIEW_THRESHOLD; anything
 * weaker is NEW. Exact boundary behavior is asserted with synthetic scores so
 * the tests do not depend on Jaro-Winkler values for hand-picked strings.
 */

function fp(
  lineNumber: number,
  name: string,
  city: string,
  domain: string | null,
  phone: string | null,
): DedupFingerprint {
  return fingerprintRow({ lineNumber, name, city, domain, phone });
}

describe("fingerprintRow normalization", () => {
  it("normalizes company names to a comparable form", () => {
    const a = fp(2, "ACME Packaging, Inc.", "Chicago", null, null);
    const b = fp(3, "acme packaging", "chicago", null, null);
    expect(a.normalizedName).toBe(b.normalizedName);
    expect(a.normalizedName).not.toBe("");
    // Punctuation and corp suffixes are stripped; single spaces are kept.
    expect(a.normalizedName).not.toMatch(/[^a-z0-9 -]/);
  });

  it("normalizes domains to bare lowercase hosts", () => {
    const a = fp(2, "Acme Packaging", "Chicago", "HTTPS://Acme.Example/contact", null);
    const b = fp(3, "Acme Packaging", "Chicago", "acme.example", null);
    expect(a.domain).toBe("acme.example");
    expect(b.domain).toBe(a.domain);
  });

  it("reduces phone numbers to digit keys", () => {
    const a = fp(2, "Acme Packaging", "Chicago", null, "(555) 123-4567");
    const b = fp(3, "Acme Packaging", "Chicago", null, "555.123.4567");
    expect(a.phoneKey).toBe("5551234567");
    expect(b.phoneKey).toBe(a.phoneKey);
  });

  it("keeps missing contact signals as null", () => {
    const row = fp(2, "Acme Packaging", "Chicago", null, null);
    expect(row.domain).toBeNull();
    expect(row.phoneKey).toBeNull();
  });
});

describe("scorePair", () => {
  it("scores identical rows at 1", () => {
    const a = fp(2, "Summit Packaging", "Denver", "summitpkg.example", "5551234567");
    const b = fp(3, "Summit Packaging", "Denver", "summitpkg.example", "5551234567");
    const pair = scorePair(a, b);
    expect(pair.score).toBe(1);
    expect(pair.nameSimilarity).toBe(1);
    expect(pair.matchedSignals).toEqual(["name", "city", "domain", "phone"]);
  });

  it("is symmetric", () => {
    const a = fp(2, "Summit Packaging", "Denver", "summitpkg.example", null);
    const b = fp(3, "Summit Packaging Co", "Denver", "summitpkg.example", "5551234567");
    expect(scorePair(a, b)).toEqual(scorePair(b, a));
  });

  it("only counts a signal when both sides carry it", () => {
    const a = fp(2, "Summit Packaging", "Denver", "summitpkg.example", null);
    const b = fp(3, "Summit Packaging", "Denver", null, "5551234567");
    const pair = scorePair(a, b);
    expect(pair.matchedSignals).toContain("city");
    expect(pair.matchedSignals).not.toContain("domain");
    expect(pair.matchedSignals).not.toContain("phone");
  });

  it("keeps unrelated companies in the same city below the review band", () => {
    const a = fp(2, "Alpha Bottles", "Chicago", null, null);
    const b = fp(3, "Zephyr Labels", "Chicago", null, null);
    const pair = scorePair(a, b);
    expect(pair.score).toBeLessThan(REVIEW_THRESHOLD);
    expect(decideDedup(pair)).toBe("NEW");
  });
});

describe("decideDedup thresholds", () => {
  it("merges only when the score and the name floor both hold", () => {
    expect(decideDedup({ score: MERGE_THRESHOLD, nameSimilarity: NAME_MERGE_FLOOR })).toBe("MERGE");
    expect(decideDedup({ score: 0.99, nameSimilarity: 0.5 })).toBe("REVIEW");
  });

  it("treats the review band as inclusive of REVIEW_THRESHOLD", () => {
    expect(decideDedup({ score: REVIEW_THRESHOLD, nameSimilarity: 0.99 })).toBe("REVIEW");
    expect(decideDedup({ score: 0.6999, nameSimilarity: 0.99 })).toBe("NEW");
  });

  it("never merges on a strong score with a weak name", () => {
    expect(decideDedup({ score: 0.88, nameSimilarity: 0.84 })).toBe("REVIEW");
    expect(decideDedup({ score: 0.88, nameSimilarity: 0.86 })).toBe("MERGE");
  });
});

describe("blockingKeys", () => {
  it("emits prefixed keys for every present signal", () => {
    const row = fp(2, "Summit Packaging", "Denver", "summitpkg.example", "5551234567");
    expect(blockingKeys(row)).toEqual([
      "city:denver",
      "domain:summitpkg.example",
      "phone:5551234567",
    ]);
  });

  it("emits no keys when every signal is missing", () => {
    const row = fp(2, "Summit Packaging", "", null, null);
    expect(blockingKeys(row)).toEqual([]);
  });
});

describe("seed slug coverage (CI failure class: non-canonical bank keys)", () => {
  it("has a title bank for every top-level category slug", () => {
    for (const slug of TOP_LEVEL_CATEGORY_SLUGS) {
      expect(() => listingTitle(slug, 0)).not.toThrow();
      expect(listingTitle(slug, 0).length).toBeGreaterThan(0);
    }
  });

  it("assertTopLevelSlugKeys throws on missing or unknown keys", () => {
    expect(() => assertTopLevelSlugKeys("ok", TOP_LEVEL_CATEGORY_SLUGS)).not.toThrow();
    const [first] = TOP_LEVEL_CATEGORY_SLUGS;
    expect(() => assertTopLevelSlugKeys("short", [first ?? ""])).toThrow(/missing/);
    expect(() =>
      assertTopLevelSlugKeys("typo", [...TOP_LEVEL_CATEGORY_SLUGS, "not-a-slug"]),
    ).toThrow(/unknown: not-a-slug/);
  });
});
