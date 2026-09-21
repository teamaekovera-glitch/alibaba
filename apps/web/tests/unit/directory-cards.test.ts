import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SupplierCard } from "@/components/directory/supplier-card";
import { CategoryCard } from "@/components/directory/category-card";

/**
 * Card render coverage without a database: the props-driven components from
 * the spec sketch render their record subset into the marketplace-grid
 * markup, including the browse-only guarantee (links to /directory, no
 * transactional UI).
 */

const flatlands = {
  slug: "flatlands-processing-co",
  name: "Flatlands Processing LLC",
  dba: null,
  supplierTypes: ["Ingredient Supplier", "Co-Packer", "Food Manufacturer / Brand"],
  city: "Haxtun",
  state: "CO",
  certifications: ["USDA Organic", "Non-GMO Project"],
  specialty: "Organic grain cleaning & bagging",
  primaryCategory: "grains-baking",
};

describe("SupplierCard", () => {
  it("renders identity, initials avatar, badges, and the /directory link", () => {
    const html = renderToStaticMarkup(
      createElement(SupplierCard, { supplier: flatlands, categoryTint: "bg-gradient-to-br from-yellow-100" }),
    );
    expect(html).toContain("Flatlands Processing LLC");
    expect(html).toContain(">FP<");
    expect(html).toContain("Ingredient Supplier");
    expect(html).toContain("+1");
    expect(html).toContain("Haxtun, CO");
    expect(html).toContain("USDA Organic");
    expect(html).toContain("Organic grain cleaning &amp; bagging");
    expect(html).toContain('href="/directory/flatlands-processing-co"');
  });

  it("shows the DBA line when present", () => {
    const html = renderToStaticMarkup(
      createElement(SupplierCard, {
        supplier: { ...flatlands, dba: "Sweet Sam's" },
        categoryTint: "bg-gradient-to-br",
      }),
    );
    expect(html).toContain("d/b/a Sweet Sam&#x27;s");
  });

  it("stays renderable when optional fields are null", () => {
    const html = renderToStaticMarkup(
      createElement(SupplierCard, {
        supplier: { ...flatlands, dba: null, city: null, state: null, certifications: [], specialty: null, supplierTypes: [] },
        categoryTint: "bg-gradient-to-br",
      }),
    );
    expect(html).toContain("Flatlands Processing LLC");
    expect(html).not.toContain("d/b/a");
  });
});

describe("CategoryCard", () => {
  it("renders artwork, description, and the live count", () => {
    const html = renderToStaticMarkup(
      createElement(CategoryCard, {
        category: {
          slug: "dairy",
          name: "Dairy & Cheese",
          description: "Milk, cheese, yogurt & whey producers",
          image: "/discovery/dairy.jpg",
        },
        count: 918,
      }),
    );
    expect(html).toContain('href="/categories/dairy"');
    expect(html).toContain('src="/discovery/dairy.jpg"');
    expect(html).toContain("Dairy &amp; Cheese");
    expect(html).toContain("Milk, cheese, yogurt &amp; whey producers");
    expect(html).toContain("918 suppliers");
  });

  it("labels an unpopulated category as coming soon", () => {
    const html = renderToStaticMarkup(
      createElement(CategoryCard, {
        category: { slug: "pet-food", name: "Pet Food", description: "Pet food makers", image: "/discovery/pet-food.jpg" },
        count: 0,
      }),
    );
    expect(html).toContain("Coming soon");
  });
});
