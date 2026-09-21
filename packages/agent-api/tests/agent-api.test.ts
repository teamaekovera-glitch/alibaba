import { describe, expect, it } from "vitest";
import {
  AGENT_MAX_PAGE_SIZE,
  agentAuth,
  agentKeyForOrg,
  agentPage,
  bearerKey,
  checkRateLimit,
  parseAgentPaging,
  resetRateLimits,
  serializeAgentListing,
  serializeAgentSearchHit,
  serializeAgentSupplier,
  verifyAgentKey,
  type ListingSearchDocument,
} from "../src";

const ORG_ID = "org_test_1";

describe("org-scoped mock API keys", () => {
  it("derives a deterministic key per org", () => {
    const key = agentKeyForOrg(ORG_ID);
    expect(key).toBe(agentKeyForOrg(ORG_ID));
    expect(key).toMatch(/^pak_/);
    expect(agentKeyForOrg("org_other")).not.toBe(key);
  });

  it("verifies a key and extracts the bearer org", () => {
    const verified = verifyAgentKey(agentKeyForOrg(ORG_ID));
    expect(verified).toEqual({ orgId: ORG_ID });
  });

  it("rejects tampered, malformed, and missing keys without throwing", () => {
    const key = agentKeyForOrg(ORG_ID);
    expect(verifyAgentKey(`${key}0`)).toBeNull(); // tampered check value
    expect(verifyAgentKey(`pak_nounderscore`)).toBeNull();
    expect(verifyAgentKey("sk_something_else")).toBeNull();
    expect(verifyAgentKey("")).toBeNull();
    expect(verifyAgentKey(null)).toBeNull();
    expect(verifyAgentKey(undefined)).toBeNull();
  });

  it("survives org ids containing underscores", () => {
    const verified = verifyAgentKey(agentKeyForOrg("org_with_underscores"));
    expect(verified).toEqual({ orgId: "org_with_underscores" });
  });

  it("parses Bearer authorization headers", () => {
    expect(bearerKey("Bearer abc")).toBe("abc");
    expect(bearerKey("Bearer abc  ")).toBe("abc");
    expect(bearerKey("Basic abc")).toBeNull();
    expect(bearerKey("Bearer ")).toBeNull();
    expect(bearerKey(null)).toBeNull();
  });

  it("agentAuth rejects requests without a valid key with a stable 401", () => {
    const denied = agentAuth(new Request("https://x/api/agent/listings"));
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.response.status).toBe(401);
    }
    const allowed = agentAuth(
      new Request("https://x/api/agent/listings", {
        headers: { authorization: `Bearer ${agentKeyForOrg(ORG_ID)}` },
      }),
    );
    expect(allowed).toEqual({ ok: true, orgId: ORG_ID });
  });
});

describe("rate-limit middleware stub", () => {
  const T0 = new Date("2026-09-21T12:00:00.000Z");

  it("allows requests up to the limit then blocks", () => {
    resetRateLimits();
    const config = { limit: 3, windowMs: 1_000 };
    expect(checkRateLimit("k1", T0, config).allowed).toBe(true);
    expect(checkRateLimit("k1", T0, config).allowed).toBe(true);
    const third = checkRateLimit("k1", T0, config);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    expect(checkRateLimit("k1", T0, config).allowed).toBe(false);
  });

  it("does not consume quota when blocked", () => {
    resetRateLimits();
    const config = { limit: 1, windowMs: 1_000 };
    checkRateLimit("k2", T0, config);
    for (let i = 0; i < 5; i += 1) {
      const denied = checkRateLimit("k2", T0, config);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
    }
  });

  it("resets after the window elapses", () => {
    resetRateLimits();
    const config = { limit: 1, windowMs: 1_000 };
    expect(checkRateLimit("k3", T0, config).allowed).toBe(true);
    expect(checkRateLimit("k3", new Date(T0.getTime() + 999), config).allowed).toBe(false);
    expect(checkRateLimit("k3", new Date(T0.getTime() + 1_000), config).allowed).toBe(true);
  });

  it("isolates identifiers", () => {
    resetRateLimits();
    const config = { limit: 1, windowMs: 1_000 };
    checkRateLimit("k4", T0, config);
    expect(checkRateLimit("k5", T0, config).allowed).toBe(true);
  });

  it("reports the window reset time for Retry-After", () => {
    resetRateLimits();
    const decision = checkRateLimit("k6", T0, { limit: 1, windowMs: 60_000 });
    expect(decision.resetAt).toBe(T0.getTime() + 60_000);
  });

  it("clamps paging params and keeps the success envelope stable", () => {
    const params = new URLSearchParams("limit=999&offset=-5");
    const paging = parseAgentPaging(params);
    expect(paging.limit).toBe(AGENT_MAX_PAGE_SIZE);
    expect(paging.offset).toBe(0);
    expect(parseAgentPaging(new URLSearchParams())).toEqual({ limit: 25, offset: 0 });

    const page = agentPage([1, 2], { limit: 25, offset: 0 }, 2);
    expect(page.status).toBe(200);
  });
});

describe("stable agent shapes", () => {
  const document: ListingSearchDocument = {
    id: "listing_1",
    title: "120ml PET syrup bottle",
    body: "Food-grade PET bottle for syrup lines.",
    slug: "acme-120ml-pet-syrup-bottle",
    categoryFamily: "rigid",
    format: "pet-bottles",
    material: "PET",
    sizeBand: "100-250ml",
    moqBand: "1k-10k",
    priceCents: 14,
    moqQty: 5_000,
    leadTimeDays: 21,
    leadTimeBand: "15-30d",
    city: ["Ho Chi Minh City"],
    country: ["VN"],
    geo: null,
    certifications: ["FSSC22000"],
    sustainability: ["recyclable"],
  } as ListingSearchDocument;

  const supplier = { id: "org_supplier", name: "Acme Packaging", slug: "acme-packaging" };

  it("serializes listings with a stable canonical URL and integer cents", () => {
    const listing = serializeAgentListing(document, supplier);
    expect(listing.url).toBe("/listings/acme-120ml-pet-syrup-bottle");
    expect(listing.price.fromCents).toBe(14);
    expect(listing.moq.qty).toBe(5_000);
    expect(listing.category).toEqual({ family: "rigid", leaf: "pet-bottles" });
    expect(listing.supplier).toEqual(supplier);
    expect(listing.certifications).toEqual(["FSSC22000"]);
    expect(listing.sustainability).toEqual(["recyclable"]);
  });

  it("serializes deterministically — identical input, identical output string", () => {
    expect(JSON.stringify(serializeAgentListing(document, supplier))).toBe(
      JSON.stringify(serializeAgentListing(document, supplier)),
    );
  });

  it("serializes suppliers from profile data and defaults when absent", () => {
    const org = {
      id: "org_supplier",
      name: "Acme Packaging",
      slug: "acme-packaging",
      supplierProfile: {
        verificationStatus: "VERIFIED",
        responseTimeHours: 4.5,
        minOrderValueCents: 120_000,
        paymentTerms: "DEPOSIT_30_70",
        about: "Rigid packaging specialist.",
        plants: [
          { city: "Ho Chi Minh City", country: "VN", isPrimary: true },
          { city: "Da Nang", country: "VN", isPrimary: false },
        ],
      },
    };
    const supplierJson = serializeAgentSupplier(org);
    expect(supplierJson.verificationStatus).toBe("VERIFIED");
    expect(supplierJson.locations).toHaveLength(2);
    expect(JSON.stringify(supplierJson)).toBe(JSON.stringify(serializeAgentSupplier(org)));

    const bare = serializeAgentSupplier({
      id: "org_bare",
      name: "Bare Org",
      slug: "bare-org",
      supplierProfile: null,
    });
    expect(bare.verificationStatus).toBe("UNVERIFIED");
    expect(bare.paymentTerms).toBe("NET_30");
    expect(bare.locations).toEqual([]);
    expect(bare.minOrderValueCents).toBeNull();
  });

  it("wraps search hits with the engine score", () => {
    const hit = serializeAgentSearchHit(document, supplier, 0.87);
    expect(hit.score).toBe(0.87);
    expect(hit.listing.slug).toBe(document.slug);
  });
});
