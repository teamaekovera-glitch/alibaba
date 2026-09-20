import { describe, expect, it } from "vitest";

import {
  COMPARE_LIMIT,
  parseCompareSlugs,
  serializeCompareSlugs,
  toggledCompareSlugs,
} from "@/lib/compare-cookie";

describe("parseCompareSlugs", () => {
  it("returns an empty selection for a missing cookie", () => {
    expect(parseCompareSlugs(undefined)).toEqual([]);
    expect(parseCompareSlugs(null)).toEqual([]);
    expect(parseCompareSlugs("")).toEqual([]);
  });

  it("splits on commas and drops empties", () => {
    expect(parseCompareSlugs("a,b")).toEqual(["a", "b"]);
    expect(parseCompareSlugs("a,,b,")).toEqual(["a", "b"]);
  });

  it("dedupes while keeping first-seen order", () => {
    expect(parseCompareSlugs("b,a,b")).toEqual(["b", "a"]);
  });

  it("caps the tray at the compare limit", () => {
    expect(parseCompareSlugs("a,b,c,d,e,f")).toHaveLength(COMPARE_LIMIT);
    expect(parseCompareSlugs("a,b,c,d,e").at(-1)).toBe("d");
  });
});

describe("serializeCompareSlugs", () => {
  it("round-trips with parse", () => {
    const slugs = ["seed-listing-0002", "seed-listing-0001"];
    expect(parseCompareSlugs(serializeCompareSlugs(slugs))).toEqual(slugs);
  });

  it("rejects selections past the cap (callers must toggle, not bulk-write)", () => {
    expect(() => serializeCompareSlugs(["a", "b", "c", "d", "e"])).toThrow(/at most 4/);
  });
});

describe("toggledCompareSlugs", () => {
  it("adds a slug", () => {
    expect(toggledCompareSlugs(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes a slug", () => {
    expect(toggledCompareSlugs(["a", "b"], "a")).toEqual(["b"]);
  });

  it("is a no-op when the tray is full (UI messages instead of dropping)", () => {
    expect(toggledCompareSlugs(["a", "b", "c", "d"], "e")).toEqual(["a", "b", "c", "d"]);
  });
});
