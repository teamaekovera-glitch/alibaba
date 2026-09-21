import { describe, expect, it } from "vitest";
import { fnv1a, initialsFor, avatarGradient, categoryTint } from "@/components/directory/visuals";
import { buildCategoryHref } from "@/components/directory/links";
import { categoryCountLabel } from "@/components/directory/category-card";
import { pageWindow } from "@/components/directory/pagination";

describe("fnv1a", () => {
  // Canonical 32-bit FNV-1a vectors (LHN published constants).
  it("matches the standard FNV-1a basis vectors", () => {
    expect(fnv1a("")).toBe(2166136261);
    expect(fnv1a("a")).toBe(3826002220);
  });

  it("is deterministic and input-sensitive", () => {
    expect(fnv1a("Flatlands Processing LLC")).toBe(fnv1a("Flatlands Processing LLC"));
    expect(fnv1a("Flatlands Processing LLC")).not.toBe(fnv1a("Sweet Sam's Baking Co"));
  });
});

describe("initialsFor", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsFor("Flatlands Processing LLC")).toBe("FP");
    expect(initialsFor("Sweet Sam's Baking Co")).toBe("SS");
  });

  it("handles one word and empty input", () => {
    expect(initialsFor("Walmart")).toBe("W");
    expect(initialsFor("   ")).toBe("?");
  });
});

describe("avatarGradient and categoryTint", () => {
  it("maps every discovery slug to a tint and falls back neutral for unknown slugs", () => {
    for (const slug of ["dairy", "pet-food", "other-general"]) {
      // Contract: gradient stop classes (from-/via-/to-); callers compose
      // them with the bg-gradient-to-br prefix.
      expect(categoryTint(slug)).toMatch(/^from-/);
      expect(categoryTint(slug)).toContain("to-");
    }
    expect(categoryTint("not-a-slug")).toBe(categoryTint("other-general"));
  });

  it("rotates the gradient deterministically by name", () => {
    expect(avatarGradient("dairy", "Acme")).toBe(avatarGradient("dairy", "Acme"));
    expect(avatarGradient("dairy", "Acme")).not.toBe(avatarGradient("beverages", "Acme"));
  });
});

describe("categoryCountLabel", () => {
  it("labels zero, one, and many honestly", () => {
    expect(categoryCountLabel(0)).toBe("Coming soon");
    expect(categoryCountLabel(1)).toBe("1 supplier");
    expect(categoryCountLabel(918)).toBe("918 suppliers");
  });
});

describe("buildCategoryHref", () => {
  it("omits default params and composes facet, sort, and page", () => {
    expect(buildCategoryHref("dairy")).toBe("/categories/dairy");
    expect(buildCategoryHref("dairy", { page: 1 })).toBe("/categories/dairy");
    expect(buildCategoryHref("dairy", { page: 2, type: "Co-Packer", sort: "tier" })).toBe(
      "/categories/dairy?page=2&type=Co-Packer",
    );
    expect(buildCategoryHref("dairy", { sort: "name" })).toBe("/categories/dairy?sort=name");
    expect(buildCategoryHref("bakery", { type: "Co-Manufacturer" })).toBe(
      "/categories/bakery?type=Co-Manufacturer",
    );
  });
});

describe("pageWindow", () => {
  it("renders nothing for single-page grids", () => {
    expect(pageWindow(1, 1)).toEqual([]);
  });

  it("brackets the current page with ellipses and adds prev/next", () => {
    const items = pageWindow(24, 39);
    const labels = items.map((item) => item.label);
    expect(labels).toEqual(["1", "…", "23", "24", "25", "…", "39", "← Prev", "Next →"]);
    expect(items.find((item) => item.kind === "current")?.page).toBe(24);
  });

  it("keeps the ends reachable without ellipsis noise on short ranges", () => {
    const labels = pageWindow(2, 3).map((item) => item.label);
    expect(labels).toEqual(["1", "2", "3", "← Prev", "Next →"]);
  });
});
