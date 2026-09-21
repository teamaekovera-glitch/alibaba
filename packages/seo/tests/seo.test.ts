import { describe, expect, it } from "vitest";

import {
  absoluteUrl,
  buildPageMetadata,
  organizationJsonLd,
  productJsonLd,
  robotsRules,
  sitemapEntries,
  siteUrl,
  SITE_URL_ENV,
} from "@/index";

const SITE = "https://packsource.test";

describe("site origin", () => {
  it("falls back to the production origin without an env override", () => {
    expect(siteUrl({})).toBe("https://packsource.aekovera.com");
  });

  it("prefers NEXT_PUBLIC_SITE_URL and strips trailing slashes", () => {
    expect(siteUrl({ [SITE_URL_ENV]: "https://preview.example.com/" })).toBe("https://preview.example.com");
  });

  it("ignores blank overrides", () => {
    expect(siteUrl({ [SITE_URL_ENV]: "   " })).toBe("https://packsource.aekovera.com");
  });

  it("joins absolute URLs from root-relative paths", () => {
    expect(absoluteUrl(SITE, "/products/x")).toBe(`${SITE}/products/x`);
    expect(absoluteUrl(SITE, "products/x")).toBe(`${SITE}/products/x`);
  });
});

describe("buildPageMetadata", () => {
  it("builds canonical, OpenGraph, and robots data", () => {
    const meta = buildPageMetadata({
      site: SITE,
      title: "T",
      description: "D",
      path: "/products/t",
    });
    expect(meta.canonicalUrl).toBe(`${SITE}/products/t`);
    expect(meta.openGraph.url).toBe(`${SITE}/products/t`);
    expect(meta.openGraph.type).toBe("website");
    expect(meta.robots).toEqual({ index: true, follow: true });
  });

  it("marks noIndex pages", () => {
    const meta = buildPageMetadata({ site: SITE, title: "T", description: "D", path: "/sign-in", noIndex: true });
    expect(meta.robots).toEqual({ index: false, follow: false });
  });
});

describe("productJsonLd", () => {
  it("builds schema.org/Product with an integer-cent Offer", () => {
    const jsonld = productJsonLd({
      site: SITE,
      slug: "pet-bottle",
      title: "500ml PET bottle",
      description: "Food-grade bottle",
      priceCents: 1450,
      supplierName: "Acme Pack",
      dateModified: "2026-09-21T00:00:00.000Z",
    });
    expect(jsonld["@type"]).toBe("Product");
    expect(jsonld.url).toBe(`${SITE}/products/pet-bottle`);
    const offers = jsonld.offers as Record<string, unknown>;
    expect(offers.price).toBe("14.50");
    expect(offers.priceCurrency).toBe("USD");
    expect(jsonld.brand).toEqual({ "@type": "Brand", name: "Acme Pack" });
    expect(jsonld.dateModified).toBe("2026-09-21T00:00:00.000Z");
  });

  it("omits the offer when no price exists and keeps the shape stable", () => {
    const jsonld = productJsonLd({
      site: SITE,
      slug: "x",
      title: "T",
      description: null,
      priceCents: null,
      supplierName: "S",
    });
    expect("offers" in jsonld).toBe(false);
    expect("description" in jsonld).toBe(false);
    expect("image" in jsonld).toBe(false);
  });
});

describe("organizationJsonLd", () => {
  it("builds schema.org/Organization with the primary plant address", () => {
    const jsonld = organizationJsonLd({
      site: SITE,
      slug: "acme-pack",
      name: "Acme Pack",
      about: null,
      locations: [
        { city: "Ho Chi Minh City", country: "VN" },
        { city: "Da Nang", country: "VN" },
      ],
    });
    expect(jsonld["@type"]).toBe("Organization");
    expect(jsonld.url).toBe(`${SITE}/suppliers/acme-pack`);
    const address = jsonld.address as Record<string, unknown>;
    expect(address.addressLocality).toBe("Ho Chi Minh City");
    expect(address.addressCountry).toBe("VN");
    expect("description" in jsonld).toBe(false);
  });

  it("honors basePath for directory profiles while the default stays /suppliers", () => {
    const input = {
      site: SITE,
      slug: "sweet-sams-baking-co",
      name: "Sweet Sam's Baking Co",
      about: "Wholesale bakery",
      locations: [{ city: "Bronx", country: "US" }],
    } as const;
    expect(organizationJsonLd(input).url).toBe(`${SITE}/suppliers/sweet-sams-baking-co`);
    expect(organizationJsonLd({ ...input, basePath: "/directory" }).url).toBe(
      `${SITE}/directory/sweet-sams-baking-co`,
    );
  });
});

describe("sitemapEntries", () => {
  it("orders statics, then listings and suppliers deterministically by slug", () => {
    const entries = sitemapEntries({
      site: SITE,
      staticPaths: [
        { path: "/", priority: 1 },
        { path: "/search", priority: 0.9 },
      ],
      listings: [
        { slug: "zeal-bottle", updatedAt: new Date("2026-09-01T00:00:00.000Z") },
        { slug: "alpha-pouch", updatedAt: new Date("2026-09-02T00:00:00.000Z") },
      ],
      suppliers: [{ slug: "acme-pack" }],
    });
    expect(entries.map((entry) => entry.url)).toEqual([
      `${SITE}/`,
      `${SITE}/search`,
      `${SITE}/products/alpha-pouch`,
      `${SITE}/products/zeal-bottle`,
      `${SITE}/suppliers/acme-pack`,
    ]);
    expect(entries[2]).toMatchObject({
      changeFrequency: "daily",
      priority: 0.7,
      lastModified: new Date("2026-09-02T00:00:00.000Z"),
    });
    expect(entries[4]).toMatchObject({ changeFrequency: "weekly", priority: 0.6 });
  });
});

describe("robotsRules", () => {
  it("points at the sitemap and blocks app surfaces", () => {
    const rules = robotsRules(SITE);
    expect(rules.sitemap).toBe(`${SITE}/sitemap.xml`);
    for (const path of ["/api/", "/admin/", "/cart", "/orders", "/onboarding", "/sign-in"]) {
      expect(rules.disallow).toContain(path);
    }
  });
});
