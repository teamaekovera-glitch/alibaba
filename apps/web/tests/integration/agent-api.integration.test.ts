import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@packsource/db";
import { agentKeyForOrg } from "@packsource/agent-api";

/**
 * Agent API integration tests against the deterministic seed (spec: agent
 * surface). Route handlers are invoked directly with real Requests — Next.js
 * server runtime excluded, everything else real (Prisma, in-memory search
 * index, auth and rate-limit middleware).
 *
 * Coverage contract from the acceptance criteria: auth required (401 on
 * missing/invalid keys), the catalog is public-only (moderation states and
 * never-published rows are withheld), and the rate-limit stub rejects the
 * 61st same-window request with 429 + Retry-After.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://packsource:packsource@localhost:5432/packsource_test";

process.env.DATABASE_URL ??= DATABASE_URL;

const { GET: ListingsRoute } = await import("@/app/api/agent/listings/route");
const { GET: SuppliersRoute } = await import("@/app/api/agent/suppliers/route");
const { GET: SearchRoute } = await import("@/app/api/agent/search/route");

const BASE = "http://localhost:3000";

function get(path: string, orgId?: string): Request {
  return new Request(`${BASE}${path}`, {
    headers: orgId ? { authorization: `Bearer ${agentKeyForOrg(orgId)}` } : {},
  });
}

function bare(path: string, key: string): Request {
  return new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } });
}

describe("agent API against the seed", () => {
  let prisma: PrismaClient;
  let buyerOrgId: string;
  let supplierOrgIdA: string;
  let supplierOrgIdB: string;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import("@packsource/db");
    prisma = new Client({ datasources: { db: { url: DATABASE_URL } } });
    // Same order-independent truncate/reseed handoff as the storefront suite.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "Organization", "User", "Category", "PriceBenchmark" CASCADE`,
    );
    const { seedDatabase } = await import("@packsource/db/seed");
    await seedDatabase(prisma);

    const orgs = await prisma.organization.findMany({
      select: { id: true, type: true },
      orderBy: { id: "asc" },
    });
    const suppliers = orgs.filter((org) => org.type === "SUPPLIER");
    const buyers = orgs.filter((org) => org.type === "BUYER");
    buyerOrgId = buyers[0]!.id;
    supplierOrgIdA = suppliers[0]!.id;
    supplierOrgIdB = suppliers[1]!.id;
    return async () => {
      await prisma.$disconnect();
    };
  });

  it("rejects missing, malformed, and unknown keys with a stable 401", async () => {
    const requests = [
      get("/api/agent/listings"),
      bare("/api/agent/listings", "not-a-key"),
      bare("/api/agent/listings", "pak_extra"),
    ];
    for (const request of requests) {
      const response = await ListingsRoute(request);
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    }
  });

  it("serves a paged LIVE-listing feed with stable shapes and integer cents", async () => {
    const response = await ListingsRoute(get("/api/agent/listings?limit=25", supplierOrgIdA));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Record<string, unknown>[];
      paging: { limit: number; offset: number; total: number };
    };
    expect(body.paging.limit).toBe(25);
    expect(body.paging.offset).toBe(0);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.length).toBeLessThanOrEqual(25);

    const liveCount = await prisma.listing.count({ where: { status: "LIVE" } });
    expect(body.paging.total).toBe(liveCount);

    const first = body.data[0]!;
    // Stable shape: fixed keys, integer cents, canonical /products/ URL.
    expect(first).toHaveProperty("price");
    expect(first).toHaveProperty("moq");
    expect(first).toHaveProperty("supplier");
    expect(String(first.url)).toMatch(/^\/products\//);
    expect(Number.isInteger((first.price as { fromCents: number }).fromCents)).toBe(true);
    expect(Object.keys(first).sort()).toEqual(
      [
        "certifications",
        "category",
        "description",
        "id",
        "leadTimeDays",
        "locations",
        "material",
        "moq",
        "price",
        "sizeBand",
        "slug",
        "sustainability",
        "supplier",
        "title",
        "url",
      ].sort(),
    );
  });

  it("never leaks non-LIVE listings in any page of the feed", async () => {
    const draft = await prisma.listing.findFirst({
      where: { status: { in: ["DRAFT", "PENDING_REVIEW", "PAUSED", "REJECTED"] } },
      select: { slug: true, title: true },
    });
    expect(draft).not.toBeNull();
    const liveTotal = await prisma.listing.count({ where: { status: "LIVE" } });
    const seenSlugs: string[] = [];
    for (let offset = 0; offset < liveTotal + 25; offset += 25) {
      const response = await ListingsRoute(
        get(`/api/agent/listings?limit=25&offset=${offset}`, supplierOrgIdB),
      );
      if (response.status !== 200) break;
      const body = (await response.json()) as { data: { slug: string; title: string }[] };
      for (const item of body.data) {
        seenSlugs.push(item.slug);
        expect(item.title).not.toBe(draft!.title);
      }
    }
    expect(seenSlugs).not.toContain(draft!.slug);
  });

  it("serves the supplier directory with profiles only and deterministic order", async () => {
    const response = await SuppliersRoute(get("/api/agent/suppliers?limit=100", buyerOrgId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { slug: string; verificationStatus: string; locations: unknown[] }[];
      paging: { total: number };
    };
    expect(body.data.length).toBeGreaterThan(1);
    const profileCount = await prisma.supplierProfile.count();
    expect(body.paging.total).toBe(profileCount);
    expect(new Set(body.data.map((supplier) => supplier.slug)).size).toBe(body.data.length);
    // Documented ordering: org name asc, then id. Slugs follow the name order.
    const names = body.data.map((supplier) => supplier.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(body.data.every((supplier) => supplier.verificationStatus.length > 0)).toBe(true);

    const bySlug = await SuppliersRoute(get(`/api/agent/suppliers?slug=${body.data[0]!.slug}`, buyerOrgId));
    const single = (await bySlug.json()) as { data: unknown[] };
    expect(single.data.length).toBe(1);
  });

  it("serves keyword discovery with engine scores via the public query contract", async () => {
    const live = await prisma.listing.findFirst({
      where: { status: "LIVE" },
      orderBy: { id: "asc" },
      select: { title: true, slug: true },
    });
    expect(live).not.toBeNull();
    const term = live!.title.split(/\s+/)[0]!;
    const response = await SearchRoute(
      get(`/api/agent/search?q=${encodeURIComponent(term)}`, buyerOrgId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mode: string;
      total: number;
      results: { score: number; listing: { slug: string; url: string } }[];
    };
    expect(body.mode).toBe("keyword");
    expect(body.results.length).toBeGreaterThan(0);
    for (const hit of body.results) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.listing.url).toMatch(/^\/products\//);
    }
    expect(body.results.map((hit) => hit.listing.slug)).toContain(live!.slug);
  });

  it("rejects the 61st same-window request with 429 and Retry-After", async () => {
    // A dedicated org id keeps this bucket independent of the other tests'
    // requests (the stub buckets per bearer org). Order it away from the
    // first buyer org used above.
    const org = await prisma.organization.findFirst({
      where: { type: "BUYER" },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    expect(org).not.toBeNull();
    let saw429 = false;
    for (let i = 0; i < 61; i += 1) {
      const response = await ListingsRoute(get("/api/agent/listings?limit=1", org!.id));
      if (response.status === 429) {
        saw429 = true;
        expect(response.headers.get("retry-after")).toBeTruthy();
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(saw429).toBe(true);
  });
});
