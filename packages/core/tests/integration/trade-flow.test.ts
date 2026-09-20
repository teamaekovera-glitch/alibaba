import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import {
  CartRepository,
  NegotiationRepository,
  PermissionDeniedError,
  QuoteExpiredError,
  QuoteRepository,
  RecordNotFoundError,
  RfqRepository,
  type AuthContext,
} from "../../src/index";
import { computeLandedCost, landedCostComponentsFromQuote } from "../../src/trade/landed-cost";

/**
 * End-to-end RFQ → quote → counter → award against a real pgvector Postgres:
 * a broadcast RFQ fans out matched supplier threads, suppliers quote with MOQ
 * ladders, the buyer counters, a supplier revises, the cart normalizes landed
 * cost, and acceptance creates the draft order — with every permission gate,
 * scope boundary, expiry rule, contact redaction, and audit event asserted on
 * the way through.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const DAY = 24 * 60 * 60 * 1000;

let buyer!: { id: string; org: { id: string } };
let s1!: { id: string; org: { id: string } };
let s2!: { id: string; org: { id: string } };
let outsider!: { id: string; org: { id: string } };

function authFor(person: { id: string; org: { id: string } }): AuthContext {
  return { userId: person.id, orgId: person.org.id, role: person === buyer ? "BUYER" : "SUPPLIER_SALES" };
}

const rfqFor = (p: { id: string; org: { id: string } }) => new RfqRepository(prisma, authFor(p));
const quotes = (p: { id: string; org: { id: string } }) => new QuoteRepository(prisma, authFor(p));
const negotiate = (p: { id: string; org: { id: string } }) => new NegotiationRepository(prisma, authFor(p));
const cart = (p: { id: string; org: { id: string } }) => new CartRepository(prisma, authFor(p));

const FUTURE = () => new Date(Date.now() + 30 * DAY);

beforeAll(() => {
  // CI's service container starts empty — apply the committed migrations here.
  execSync("npx prisma migrate deploy", {
    cwd: dbPkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  // Category has no FK into the tables above, so CASCADE never reaches it —
  // truncate it explicitly or its unique slug collides on re-runs.
  return prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "AuditLog", "Category" CASCADE`,
  );
}, 60_000);

beforeAll(async () => {
  const buyerUser = await prisma.user.create({ data: { email: "buyer@harvest-int.test" } });
  const buyerOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Harvest Labs (integration)",
      slug: "harvest-labs-int",
      members: { create: { userId: buyerUser.id, role: "BUYER" } },
    },
  });
  buyer = { id: buyerUser.id, org: { id: buyerOrg.id } };

  const makeSupplier = async (email: string, name: string, slug: string) => {
    const user = await prisma.user.create({ data: { email } });
    const org = await prisma.organization.create({
      data: {
        type: "SUPPLIER",
        name,
        slug,
        members: { create: { userId: user.id, role: "SUPPLIER_SALES" } },
        supplierProfile: { create: {} },
      },
    });
    return { id: user.id, org: { id: org.id } };
  };
  s1 = await makeSupplier("s1@supplier-one-int.test", "Supplier One (integration)", "supplier-one-int");
  s2 = await makeSupplier("s2@supplier-two-int.test", "Supplier Two (integration)", "supplier-two-int");
  outsider = await makeSupplier("x@outsider-int.test", "Outsider (integration)", "outsider-int");

  const category = await prisma.category.create({
    data: { name: "Corrugated Mailers", slug: "corrugated-mailers-int", attributeSet: {} },
  });

  // Supplier One: LIVE listing with a two-step MOQ ladder, plus a DRAFT
  // listing that must never match a broadcast.
  await prisma.listing.create({
    data: {
      orgId: s1.org.id,
      categoryId: category.id,
      title: "Kraft Corrugated Mailer 12x12x4",
      slug: "kraft-mailer-1212-int",
      status: "LIVE",
      attributes: {},
      publishedAt: new Date(),
      moqTiers: {
        create: [
          { orgId: s1.org.id, minQty: 1000, unitPriceCents: 42 },
          { orgId: s1.org.id, minQty: 5000, unitPriceCents: 36 },
        ],
      },
    },
  });
  await prisma.listing.create({
    data: {
      orgId: s1.org.id,
      categoryId: category.id,
      title: "Unpublished Kraft Mailer",
      slug: "kraft-mailer-draft-int",
      attributes: {},
    },
  });
  await prisma.listing.create({
    data: {
      orgId: s2.org.id,
      categoryId: category.id,
      title: "Recycled Corrugated Mailer 12x12x4",
      slug: "recycled-mailer-1212-int",
      status: "LIVE",
      attributes: {},
      publishedAt: new Date(),
      moqTiers: { create: [{ orgId: s2.org.id, minQty: 1200, unitPriceCents: 40 }] },
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("RFQ → quote → counter → award", () => {
  it("runs the full broadcast flow to a draft order", async () => {
    // 1. Buyer creates a broadcast RFQ (still DRAFT).
    const rfqRepo = rfqFor(buyer);
    const rfq = await rfqRepo.create({
      mode: "BROADCAST",
      title: "1,200 kraft mailers, need by mid-November",
      categoryId: (
        await prisma.category.findUniqueOrThrow({ where: { slug: "corrugated-mailers-int" } })
      ).id,
      quantity: 1200,
      spec: { version: 1, destination: { city: "Portland", country: "US" }, needByDate: "2026-11-15" },
      lines: [{ description: "12x12x4 kraft corrugated mailer", quantity: 1200 }],
    });
    expect(rfq.status).toBe("DRAFT");

    // 2. Sending opens the RFQ and creates one thread per matched supplier org.
    const sent = await rfqRepo.send(rfq.id);
    expect(sent.rfq.status).toBe("OPEN");
    const buyerThreads = await rfqRepo.threadsForRfq(rfq.id);
    expect(new Set(buyerThreads.map((t) => t.supplierOrgId))).toEqual(
      new Set([s1.org.id, s2.org.id]),
    );

    // Suppliers discover it in their inbox.
    const s1Inbox = await rfqFor(s1).inbox();
    expect(s1Inbox.some((t) => t.rfqId === rfq.id)).toBe(true);

    // 3. Supplier One quotes with a contact attempt in the message — redacted.
    const q1 = await quotes(s1).submit({
      rfqId: rfq.id,
      leadTimeDays: 12,
      validUntil: FUTURE(),
      dutyBps: 400,
      lines: [
        {
          description: "1,000-4,999 units",
          quantity: 1000,
          unitPriceCents: 42,
          toolingCents: 15_000,
          plateChargesCents: 5_000,
          freightCents: 15_000,
        },
        { description: "5,000+ units", quantity: 5000, unitPriceCents: 36, freightCents: 30_000 },
      ],
      message: "Reach me at rob@supplier-one-int.test or +1 555 010 2030 for artwork files.",
    });
    expect(q1.status).toBe("SUBMITTED");
    const s1Thread = buyerThreads.find((t) => t.supplierOrgId === s1.org.id)!;
    const s1Messages = await negotiate(buyer).threadMessages(s1Thread.id);
    const bodies = s1Messages.map((m) => m.body ?? "");
    expect(bodies.join("\n")).not.toContain("rob@supplier-one-int.test");
    expect(bodies.join("\n")).not.toContain("555 010 2030");

    // 4. Supplier Two undercuts on unit price.
    const q2 = await quotes(s2).submit({
      rfqId: rfq.id,
      leadTimeDays: 10,
      validUntil: FUTURE(),
      dutyBps: 500,
      lines: [
        {
          description: "1,200 units",
          quantity: 1200,
          unitPriceCents: 40,
          toolingCents: 10_000,
          freightCents: 12_000,
        },
      ],
      message: "We can do better on volume — open to a counter.",
    });

    // 5. Buyer sees both quotes; Supplier One sees only its own.
    const buyerView = await quotes(buyer).listForRfq(rfq.id);
    expect(new Set(buyerView.map((q) => q.id))).toEqual(new Set([q1.id, q2.id]));
    const s1View = await quotes(s1).listForRfq(rfq.id);
    expect(s1View.map((q) => q.id)).toEqual([q1.id]); // no competitor leak

    // 6. Buyer counters Supplier Two on-thread; Supplier Two revises 40 → 38.
    const s2Thread = buyerThreads.find((t) => t.supplierOrgId === s2.org.id)!;
    await negotiate(buyer).postMessage(s2Thread.id, {
      kind: "COUNTER_OFFER",
      terms: { unitPriceCents: 38, leadTimeDays: 10 },
      body: "Can you do 38 cents at 1,200 units?",
    });
    const { revision, head } = await negotiate(s2).counterQuote(q2.id, {
      unitPriceCents: 38,
      message: "38 cents works at this volume.",
    });
    expect(head.status).toBe("SUPERSEDED");
    expect(revision).toMatchObject({
      parentQuoteId: q2.id,
      revision: 2, // original quote is revision 1 — first counter is revision 2
      status: "SUBMITTED",
      unitPriceCents: 38,
    });

    // 7. The cart normalizes landed cost and sorts cheapest-first.
    const buyerCart = cart(buyer);
    await buyerCart.addToCart(q1.id);
    await buyerCart.addToCart(revision.id); // revision, not the superseded head
    const items = await buyerCart.listCart();
    expect(items.map((i) => i.quote.id)).toEqual([revision.id, q1.id]); // 58¢ < 74¢ landed

    // Landed cost from the persisted rows (lines included), not the bare returns.
    const [revisionFull, q1Full] = await Promise.all([
      prisma.quote.findUniqueOrThrow({ where: { id: revision.id }, include: { lines: true } }),
      prisma.quote.findUniqueOrThrow({ where: { id: q1.id }, include: { lines: true } }),
    ]);
    const revisionLanded = computeLandedCost(landedCostComponentsFromQuote(revisionFull));
    expect(revisionLanded.unitLandedCents).toBe(58); // 38 + 10 freight + 2 duty + 8 amortized
    const q1Landed = computeLandedCost(landedCostComponentsFromQuote(q1Full));
    expect(q1Landed.unitLandedCents).toBe(74); // 42 + 13 freight + 2 duty + 17 amortized

    // 8. Accepting the winner awards the RFQ and creates the draft order.
    const { order, quote: acceptedQuote, declinedCompetitors } = await buyerCart.acceptQuote(revision.id);
    expect(order).toMatchObject({ status: "DRAFT", orgId: buyer.org.id });
    expect(acceptedQuote.status).toBe("ACCEPTED");
    expect(declinedCompetitors).toBe(1); // Supplier One's competing quote

    const awardedRfq = await prisma.rfq.findUniqueOrThrow({ where: { id: rfq.id } });
    expect(awardedRfq.status).toBe("AWARDED");
    expect(awardedRfq.awardedQuoteId).toBe(revision.id);
    await expect(prisma.quote.findUniqueOrThrow({ where: { id: q1.id } })).resolves.toMatchObject({
      status: "DECLINED",
    });

    // Order + lines exist in the initial pre-payment state, integer cents only.
    const orderLines = await prisma.orderLine.findMany({ where: { orderId: order.id } });
    expect(orderLines.length).toBeGreaterThan(0);
    for (const line of orderLines) {
      expect(Number.isInteger(line.totalCents)).toBe(true);
    }

    // 9. Audit events for every transition, attributed to the acting org/user.
    const actions = await prisma.auditLog.findMany({
      where: { orgId: buyer.org.id },
      select: { action: true, actorUserId: true, actorType: true },
    });
    const actionNames = new Set(actions.map((a) => a.action));
    for (const expected of [
      "rfq.create",
      "rfq.send",
      "cart.add",
      "quote.accept",
      "rfq.award",
      "order.create",
    ]) {
      expect(actionNames, expected).toContain(expected);
    }
    for (const row of actions) {
      expect(row.actorUserId).toBe(buyer.id);
      expect(row.actorType).toBe("user");
    }
    const supplierAudits = await prisma.auditLog.findMany({
      where: { orgId: s2.org.id, action: "negotiation.counter" },
    });
    expect(supplierAudits.length).toBe(1);
  });

  it("rejects an expired quote at accept time", async () => {
    const rfqRepo = rfqFor(buyer);
    const rfq = await rfqRepo.create({
      mode: "BROADCAST",
      title: "Second RFQ for expiry",
      categoryId: (await prisma.category.findUniqueOrThrow({ where: { slug: "corrugated-mailers-int" } })).id,
      quantity: 1200,
      spec: { version: 1, destination: { city: "Austin", country: "US" } },
      lines: [{ description: "mailer", quantity: 1200 }],
    });
    await rfqRepo.send(rfq.id);
    const quote = await quotes(s1).submit({
      rfqId: rfq.id,
      leadTimeDays: 10,
      validUntil: FUTURE(),
      lines: [{ description: "1,200 units", quantity: 1200, unitPriceCents: 42 }],
    });
    await cart(buyer).addToCart(quote.id);
    // Age the quote past its window, then accept.
    await prisma.quote.update({ where: { id: quote.id }, data: { validUntil: new Date(Date.now() - DAY) } });
    await expect(cart(buyer).acceptQuote(quote.id)).rejects.toBeInstanceOf(QuoteExpiredError);
  });

  it("blocks an auction award before the close time", async () => {
    const rfqRepo = rfqFor(buyer);
    const closesAt = new Date(Date.now() + 7 * DAY);
    const rfq = await rfqRepo.create({
      mode: "AUCTION",
      title: "Auction RFQ",
      categoryId: (await prisma.category.findUniqueOrThrow({ where: { slug: "corrugated-mailers-int" } })).id,
      quantity: 1200,
      closesAt,
      spec: { version: 1, destination: { city: "Denver", country: "US" } },
      lines: [{ description: "mailer", quantity: 1200 }],
    });
    await rfqRepo.send(rfq.id);
    const quote = await quotes(s1).submit({
      rfqId: rfq.id,
      leadTimeDays: 10,
      validUntil: FUTURE(),
      lines: [{ description: "1,200 units", quantity: 1200, unitPriceCents: 41 }],
    });
    await cart(buyer).addToCart(quote.id);
    await expect(cart(buyer).acceptQuote(quote.id)).rejects.toThrow(/close time/i);
  });

  it("sends a SINGLE-mode RFQ only to the target listing's org", async () => {
    const listing = await prisma.listing.findUniqueOrThrow({ where: { slug: "kraft-mailer-1212-int" } });
    const rfqRepo = rfqFor(buyer);
    const rfq = await rfqRepo.create({
      mode: "SINGLE",
      title: "Direct to Supplier One",
      listingId: listing.id,
      spec: { version: 1, destination: { city: "Seattle", country: "US" } },
      lines: [{ description: "mailer", quantity: 1200 }],
    });
    await rfqRepo.send(rfq.id);
    const threads = await rfqRepo.threadsForRfq(rfq.id);
    expect(threads.map((t) => t.supplierOrgId)).toEqual([s1.org.id]);
    // Supplier Two got nothing — the RFQ is invisible to them.
    await expect(rfqFor(s2).rfqForActor(rfq.id)).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});

describe("trade permission boundaries", () => {
  it("hides the RFQ from non-participant suppliers entirely", async () => {
    const rfq = await rfqFor(buyer).create({
      mode: "BROADCAST",
      title: "Scoped RFQ",
      categoryId: (await prisma.category.findUniqueOrThrow({ where: { slug: "corrugated-mailers-int" } })).id,
      quantity: 1200,
      spec: { version: 1, destination: { city: "Boise", country: "US" } },
      lines: [{ description: "mailer", quantity: 1200 }],
    });
    // Before send (no threads yet) and after, an outsider has no view.
    await expect(rfqFor(outsider).rfqForActor(rfq.id)).rejects.toBeInstanceOf(RecordNotFoundError);
    await rfqFor(buyer).send(rfq.id);
    await expect(rfqFor(outsider).rfqForActor(rfq.id)).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(quotes(outsider).listForRfq(rfq.id)).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("refuses quote submission without quote:create and cross-org RFQ management", async () => {
    const rfq = await rfqFor(buyer).create({
      mode: "BROADCAST",
      title: "Permission RFQ",
      categoryId: (await prisma.category.findUniqueOrThrow({ where: { slug: "corrugated-mailers-int" } })).id,
      quantity: 1200,
      spec: { version: 1, destination: { city: "Reno", country: "US" } },
      lines: [{ description: "mailer", quantity: 1200 }],
    });
    await rfqFor(buyer).send(rfq.id);

    // Buyers cannot submit quotes.
    await expect(
      quotes(buyer).submit({
        rfqId: rfq.id,
        leadTimeDays: 5,
        validUntil: FUTURE(),
        lines: [{ description: "x", quantity: 1200, unitPriceCents: 10 }],
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // Suppliers cannot manage (cancel) someone else's RFQ — the gate fires
    // before ownership is even considered.
    await expect(rfqFor(s1).cancel(rfq.id)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("keeps quote threads invisible to non-participants and cross-org quotes unreadable", async () => {
    const rfqRepo = rfqFor(buyer);
    const rfq = await rfqRepo.create({
      mode: "BROADCAST",
      title: "Thread-scope RFQ",
      categoryId: (await prisma.category.findUniqueOrThrow({ where: { slug: "corrugated-mailers-int" } })).id,
      quantity: 1200,
      spec: { version: 1, destination: { city: "Salem", country: "US" } },
      lines: [{ description: "mailer", quantity: 1200 }],
    });
    await rfqRepo.send(rfq.id);
    const threads = await rfqRepo.threadsForRfq(rfq.id);
    const s2Thread = threads.find((t) => t.supplierOrgId === s2.org.id)!;

    // Supplier One cannot read Supplier Two's thread or post into it.
    await expect(negotiate(s1).threadMessages(s2Thread.id)).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(
      negotiate(s1).postMessage(s2Thread.id, { kind: "MESSAGE", body: "hi" }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);

    // The outsider cannot cart-accept a quote they cannot see.
    const quote = await quotes(s2).submit({
      rfqId: rfq.id,
      leadTimeDays: 5,
      validUntil: FUTURE(),
      lines: [{ description: "1,200 units", quantity: 1200, unitPriceCents: 39 }],
    });
    // The outsider supplier has no cart permission at all — the gate fires
    // before ownership is even considered.
    await expect(cart(outsider).acceptQuote(quote.id)).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
