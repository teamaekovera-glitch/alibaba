import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import {
  InvalidReorderRuleError,
  PermissionDeniedError,
  RecordNotFoundError,
  ReorderRepository,
  type AuthContext,
} from "../../src/index";
import { addDays } from "../../src/orders/reorder-repository";

/**
 * Reorder reminders against a real pgvector Postgres: deterministic cadence
 * arithmetic (the clock is always passed in — no wall time), due windows,
 * idempotent reminder advancement, activation toggles, org scoping, and
 * audit rows.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

let buyer!: { id: string; org: { id: string } };
let otherBuyer!: { id: string; org: { id: string } };
let supplier!: { id: string; org: { id: string } };

function authFor(person: { id: string; org: { id: string } }): AuthContext {
  return { userId: person.id, orgId: person.org.id, role: "BUYER" };
}

const reorders = (person: { id: string; org: { id: string } }) => new ReorderRepository(prisma, authFor(person));

beforeAll(() => {
  execSync("npx prisma migrate deploy", {
    cwd: dbPkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "AuditLog", "Category", "Listing" CASCADE`,
  );
}, 60_000);

beforeAll(async () => {
  const makeBuyer = async (email: string, name: string, slug: string) => {
    const user = await prisma.user.create({ data: { email } });
    const org = await prisma.organization.create({
      data: {
        type: "BUYER",
        name,
        slug,
        members: { create: { userId: user.id, role: "BUYER" } },
      },
    });
    return { id: user.id, org: { id: org.id } };
  };
  buyer = await makeBuyer("reorder-buyer@int.test", "Reorder Buyer Co", "reorder-buyer");
  otherBuyer = await makeBuyer("reorder-other@int.test", "Other Buyer Co", "reorder-other");

  const supplierUser = await prisma.user.create({ data: { email: "reorder-supplier@int.test" } });
  const supplierOrg = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Reorder Supplier Co",
      slug: "reorder-supplier",
      members: { create: { userId: supplierUser.id, role: "SUPPLIER_SALES" } },
      supplierProfile: { create: {} },
    },
  });
  supplier = { id: supplierUser.id, org: { id: supplierOrg.id } };

  const category = await prisma.category.create({
    data: { name: "Reorder Pouches", slug: "reorder-pouches", attributeSet: {} },
  });
  await prisma.listing.create({
    data: {
      orgId: supplier.org.id,
      categoryId: category.id,
      title: "Stand-up Pouch 8oz",
      slug: "reorder-standup-pouch",
      attributes: {},
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("reorder rules", () => {
  it("creates a rule with a deterministic nextOrderAt = now + cadence", async () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "reorder-standup-pouch" } });
    const rule = await reorders(buyer).createRule({
      listingId: listing.id,
      cadenceDays: 30,
      now,
    });
    expect(rule.cadenceDays).toBe(30);
    expect(rule.isActive).toBe(true);
    expect(rule.nextOrderAt?.toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(rule.orgId).toBe(buyer.org.id);
  });

  it("rejects non-positive and non-integer cadences", async () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "reorder-standup-pouch" } });
    await expect(reorders(buyer).createRule({ listingId: listing.id, cadenceDays: 0, now })).rejects.toThrow(
      InvalidReorderRuleError,
    );
    await expect(reorders(buyer).createRule({ listingId: listing.id, cadenceDays: 12.5, now })).rejects.toThrow(
      InvalidReorderRuleError,
    );
    await expect(reorders(buyer).createRule({ listingId: listing.id, cadenceDays: -7, now })).rejects.toThrow(
      InvalidReorderRuleError,
    );
  });

  it("rejects rules for listings that do not exist", async () => {
    await expect(reorders(buyer).createRule({ listingId: "listing-nope", cadenceDays: 7, now: new Date() })).rejects.toThrow(
      RecordNotFoundError,
    );
  });

  it("lists only this org's rules, soonest due first", async () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "reorder-standup-pouch" } });
    await reorders(buyer).createRule({ listingId: listing.id, cadenceDays: 90, now });
    await reorders(buyer).createRule({ listingId: listing.id, cadenceDays: 14, now });

    const rules = await reorders(buyer).listRules();
    expect(rules).toHaveLength(3); // + the 30-day rule from the first test
    const cadences = rules.map((r) => r.cadenceDays);
    expect(cadences.indexOf(14)).toBeLessThan(cadences.indexOf(30));
    expect(cadences.indexOf(30)).toBeLessThan(cadences.indexOf(90));

    // The other buyer sees none of them.
    await expect(reorders(otherBuyer).listRules()).resolves.toHaveLength(0);
  });

  it("surfaces only active, due rules in the due window", async () => {
    const at = new Date("2026-04-01T00:00:00Z");
    // The 14-day rule from 03-01 is due 03-15; the 30-day rule is due 03-31;
    // the 90-day rule is due 05-30 (not yet).
    const dueAtApril = await reorders(buyer).dueRules(at);
    expect(dueAtApril.map((r) => r.cadenceDays ?? 0).sort((a, b) => a - b)).toEqual([14, 30]);

    // One day earlier only the 14-day rule is due.
    const dueAtMarch20 = await reorders(buyer).dueRules(new Date("2026-03-20T00:00:00Z"));
    expect(dueAtMarch20.map((r) => r.cadenceDays)).toEqual([14]);
  });

  it("advances nextOrderAt by the rule's own cadence, deterministically and idempotently", async () => {
    const rules = await reorders(buyer).listRules();
    const rule = rules.find((r) => r.cadenceDays === 30)!;
    const now = new Date("2026-04-02T00:00:00Z");

    const reminded = await reorders(buyer).markReminded(rule.id, now);
    expect(reminded.nextOrderAt?.toISOString()).toBe("2026-05-02T00:00:00.000Z");

    // Same moment again → same nextOrderAt (safe under job replay).
    const again = await reorders(buyer).markReminded(rule.id, now);
    expect(again.nextOrderAt?.toISOString()).toBe("2026-05-02T00:00:00.000Z");

    // A later sweep advances again from the new moment.
    const later = await reorders(buyer).markReminded(rule.id, new Date("2026-05-02T00:00:00Z"));
    expect(later.nextOrderAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("refuses cross-org reminder marking", async () => {
    const rules = await reorders(buyer).listRules();
    await expect(reorders(otherBuyer).markReminded(rules[0]!.id, new Date())).rejects.toThrow(RecordNotFoundError);
  });

  it("deactivated rules stop being due until reactivated", async () => {
    const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "reorder-standup-pouch" } });
    const rule = await reorders(buyer).createRule({
      listingId: listing.id,
      cadenceDays: 7,
      now: new Date("2026-04-01T00:00:00Z"),
    });
    const at = new Date("2026-04-08T00:00:00Z");
    await expect(reorders(buyer).dueRules(at)).resolves.toContainEqual(expect.objectContaining({ id: rule.id }));

    await reorders(buyer).setActive(rule.id, false);
    const dueAfterDeactivate = await reorders(buyer).dueRules(at);
    expect(dueAfterDeactivate.find((r) => r.id === rule.id)).toBeUndefined();

    await reorders(buyer).setActive(rule.id, true);
    const dueAfterReactivate = await reorders(buyer).dueRules(at);
    expect(dueAfterReactivate.find((r) => r.id === rule.id)).toBeDefined();
  });

  it("denies reorder management to roles without workspace:manage", async () => {
    const supplierAuth: AuthContext = { userId: supplier.id, orgId: supplier.org.id, role: "SUPPLIER_SALES" };
    const supplierReorders = new ReorderRepository(prisma, supplierAuth);
    const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "reorder-standup-pouch" } });
    await expect(supplierReorders.createRule({ listingId: listing.id, cadenceDays: 7, now: new Date() })).rejects.toThrow(
      PermissionDeniedError,
    );
    await expect(supplierReorders.listRules()).rejects.toThrow(PermissionDeniedError);
    await expect(supplierReorders.dueRules(new Date())).rejects.toThrow(PermissionDeniedError);
  });

  it("audits create, remind, and activation on the rule's org", async () => {
    const actions = await prisma.auditLog.findMany({
      where: { orgId: buyer.org.id },
      select: { action: true, actorType: true, actorUserId: true },
    });
    const reorderActions = actions.filter((a) => a.action.startsWith("reorder."));
    expect(reorderActions.length).toBeGreaterThanOrEqual(6);
    for (const row of reorderActions) {
      expect(row.actorType).toBe("user");
      expect(row.actorUserId).toBe(buyer.id);
    }
  });
});

describe("addDays", () => {
  it("adds whole days in UTC", () => {
    expect(addDays(new Date("2026-01-01T00:00:00Z"), 30).toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(addDays(new Date("2026-02-01T00:00:00Z"), 28).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});
