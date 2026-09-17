import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { attributeSetForSlug, validateAttributesForCategory } from "../../src/index";

/**
 * Schema round-trip: applies the committed migrations to a fresh database
 * (self-sufficient in CI, where the service container starts empty), writes a
 * connected slice of the domain graph, reads it back, and exercises the
 * pgvector column end-to-end.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

/** 1536-dim vectors built from a few anchor positions (others zero). */
function makeVector(anchors: Record<number, number>): string {
  const dims = new Array<number>(1536).fill(0);
  for (const [index, value] of Object.entries(anchors)) {
    dims[Number(index)] = value;
  }
  return `[${dims.join(",")}]`;
}

const RIGID_ATTRIBUTES = validateAttributesForCategory("rigid", {
  material: "GLASS",
  dimensions: { lengthMm: 65, widthMm: 65, heightMm: 122 },
  volumeMl: 355,
  neckFinish: "28-410",
  hotFillCapable: true,
  printMethod: ["OFFSET"],
  printColors: 4,
  finish: "GLOSS",
  recyclability: "WIDELY_RECYCLABLE",
  foodContact: "FOOD_GRADE",
});

beforeAll(() => {
  // CI's service container starts empty — apply the committed migrations here.
  execSync("npx prisma migrate deploy", {
    cwd: pkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "Category", "PriceBenchmark" CASCADE`,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("schema round-trip", () => {
  it("writes and reads back a connected slice of the domain graph", async () => {
    const rigidSet = attributeSetForSlug("rigid");
    if (!rigidSet) throw new Error("the rigid attribute set must exist in the packaged taxonomy");

    // Write-path attribute validation: junk is rejected before anything persists.
    expect(() =>
      validateAttributesForCategory("rigid", { material: "GLASS", notAllowed: true }),
    ).toThrow(/Attribute validation failed/);

    const ids = await prisma.$transaction(async (tx) => {
      // ── Identity & tenancy ──────────────────────────────────────────────
      const buyerOrg = await tx.organization.create({
        data: { type: "BUYER", name: "Nova Cold Brew", slug: "nova-cold-brew" },
      });
      const supplierOrg = await tx.organization.create({
        data: { type: "SUPPLIER", name: "Meridian Glassworks", slug: "meridian-glassworks" },
      });

      const buyerUser = await tx.user.create({ data: { email: "buyer@novacoldbrew.test", name: "Buyer Bea" } });
      const approverUser = await tx.user.create({ data: { email: "approver@novacoldbrew.test" } });
      const supplierUser = await tx.user.create({ data: { email: "sales@meridianglass.test", name: "Sam Sales" } });
      await tx.orgMembership.create({ data: { orgId: buyerOrg.id, userId: buyerUser.id, role: "BUYER" } });
      await tx.orgMembership.create({ data: { orgId: buyerOrg.id, userId: approverUser.id, role: "APPROVER" } });
      await tx.orgMembership.create({
        data: { orgId: supplierOrg.id, userId: supplierUser.id, role: "SUPPLIER_SALES" },
      });

      // ── Supplier profile cluster ─────────────────────────────────────────
      const profile = await tx.supplierProfile.create({
        data: {
          orgId: supplierOrg.id,
          verificationStatus: "VERIFIED",
          responseTimeHours: 2.5,
          minOrderValueCents: 250_000,
          paymentTerms: "DEPOSIT_50_50",
          about: "Glass packaging for beverage brands",
        },
      });
      const plant = await tx.plant.create({
        data: {
          orgId: supplierOrg.id,
          supplierProfileId: profile.id,
          name: "Meridian Plant 1",
          city: "Toledo",
          state: "OH",
          country: "US",
          isPrimary: true,
        },
      });
      await tx.capability.create({
        data: { orgId: supplierOrg.id, supplierProfileId: profile.id, name: "hot-fill", detail: "Up to 85°C" },
      });
      await tx.equipment.create({
        data: {
          orgId: supplierOrg.id,
          supplierProfileId: profile.id,
          kind: "FILLER",
          make: "Krones",
          specs: { speedUnitsPerHour: 24000, containerTypes: ["glass-bottle"] },
        },
      });
      await tx.certification.create({
        data: {
          orgId: supplierOrg.id,
          supplierProfileId: profile.id,
          type: "SQF",
          number: "SQF-12345",
          expiresAt: new Date("2027-06-30T00:00:00Z"),
          verifiedAt: new Date("2026-01-15T00:00:00Z"),
        },
      });

      // ── Taxonomy & catalog ───────────────────────────────────────────────
      const category = await tx.category.create({
        data: { slug: "rigid", name: "Rigid", position: 0, attributeSet: rigidSet },
      });

      const listing = await tx.listing.create({
        data: {
          orgId: supplierOrg.id,
          categoryId: category.id,
          title: "12oz Clear Glass Bottle, 28-410",
          slug: "12oz-clear-glass-bottle-28-410",
          description: "Clear flint glass beverage bottle, hot-fill capable",
          status: "LIVE",
          attributes: RIGID_ATTRIBUTES,
          stockLevel: "IN_STOCK",
          capacityUnitsPerWeek: 250_000,
          publishedAt: new Date(),
        },
      });
      const variant = await tx.listingVariant.create({
        data: {
          listingId: listing.id,
          orgId: supplierOrg.id,
          sku: "SKU-12OZ-GLASS",
          unitPriceCents: 45,
          stockQty: 120_000,
          stockLevel: "IN_STOCK",
        },
      });
      await tx.moqPriceTier.createMany({
        data: [
          { listingId: listing.id, orgId: supplierOrg.id, minQty: 5_000, unitPriceCents: 45 },
          { listingId: listing.id, orgId: supplierOrg.id, minQty: 25_000, unitPriceCents: 38 },
          { listingId: listing.id, orgId: supplierOrg.id, minQty: 100_000, unitPriceCents: 32 },
        ],
      });
      await tx.leadTimeRule.create({
        data: {
          listingId: listing.id,
          orgId: supplierOrg.id,
          qtyMin: 5_000,
          qtyMax: 50_000,
          productionDays: 21,
          shipFromPlantId: plant.id,
        },
      });
      await tx.specSheet.create({
        data: {
          listingId: listing.id,
          orgId: supplierOrg.id,
          fileId: "r2/specsheets/12oz-glass.pdf",
          title: "12oz bottle spec sheet",
          extractedAttributes: { fillVolumeMl: 355, neckFinish: "28-410" },
          confirmedAt: new Date(),
          confirmedByUserId: supplierUser.id,
        },
      });
      await tx.dielineFile.create({
        data: { listingId: listing.id, orgId: supplierOrg.id, fileId: "r2/dielines/label-dieline.pdf", label: "Label dieline" },
      });
      await tx.complianceClaim.create({
        data: { listingId: listing.id, orgId: supplierOrg.id, framework: "FDA_21CFR", claim: "Food contact compliant" },
      });

      // ── RFQ → quote → negotiation → cart ─────────────────────────────────
      const rfq = await tx.rfq.create({
        data: {
          orgId: buyerOrg.id,
          buyerUserId: buyerUser.id,
          mode: "SINGLE",
          listingId: listing.id,
          categoryId: category.id,
          title: "355ml glass bottles, hot-fill",
          quantity: 100_000,
          status: "OPEN",
          sentAt: new Date(),
        },
      });
      const rfqLine = await tx.rfqLine.create({
        data: {
          rfqId: rfq.id,
          orgId: buyerOrg.id,
          listingId: listing.id,
          listingVariantId: variant.id,
          description: "12oz clear glass bottle",
          quantity: 100_000,
          unit: "units",
        },
      });
      const quote = await tx.quote.create({
        data: {
          rfqId: rfq.id,
          orgId: supplierOrg.id,
          salesUserId: supplierUser.id,
          status: "SUBMITTED",
          quantity: 100_000,
          unitPriceCents: 38,
          freightCents: 2_000_000,
          dutyBps: 0,
          leadTimeDays: 30,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        },
      });
      const quoteLine = await tx.quoteLine.create({
        data: {
          quoteId: quote.id,
          orgId: supplierOrg.id,
          rfqLineId: rfqLine.id,
          description: "12oz clear glass bottle",
          quantity: 100_000,
          unitPriceCents: 38,
          freightCents: 2_000_000,
          totalCents: 5_800_000,
        },
      });
      await tx.negotiationMessage.create({
        data: {
          rfqId: rfq.id,
          quoteId: quote.id,
          orgId: supplierOrg.id,
          userId: supplierUser.id,
          kind: "COUNTER_OFFER",
          body: "38¢/unit at 100k, freight included east of the Mississippi",
          terms: { unitPriceCents: 38, freightCents: 2_000_000, leadTimeDays: 30 },
        },
      });
      const cart = await tx.cart.create({ data: { orgId: buyerOrg.id } });
      await tx.cartItem.create({ data: { cartId: cart.id, orgId: buyerOrg.id, quoteId: quote.id } });

      // ── Order, escrow, fulfillment ───────────────────────────────────────
      const aekoveraRef = await tx.aekoveraProjectRef.create({
        data: {
          orgId: buyerOrg.id,
          projectRef: "KURD-001",
          source: "inbound_webhook",
          payload: { stage: "packaging" },
        },
      });
      const order = await tx.order.create({
        data: {
          orgId: buyerOrg.id,
          buyerUserId: buyerUser.id,
          quoteId: quote.id,
          aekoveraProjectRefId: aekoveraRef.id,
          status: "DEPOSIT_PAID",
          paymentSchedule: "DEPOSIT_30_70",
          subtotalCents: 3_800_000,
          freightCents: 2_000_000,
          totalCents: 5_800_000,
          commissionBps: 500,
          placedAt: new Date(),
        },
      });
      const subOrder = await tx.subOrder.create({
        data: { orderId: order.id, orgId: supplierOrg.id, status: "CONFIRMED", totalCents: 5_800_000, commissionBps: 500 },
      });
      await tx.orderLine.create({
        data: {
          orderId: order.id,
          subOrderId: subOrder.id,
          orgId: buyerOrg.id,
          quoteLineId: quoteLine.id,
          listingId: listing.id,
          listingVariantId: variant.id,
          description: "12oz clear glass bottle",
          quantity: 100_000,
          unitPriceCents: 38,
          totalCents: 3_800_000,
        },
      });
      const depositInvoice = await tx.invoice.create({
        data: {
          orderId: order.id,
          subOrderId: subOrder.id,
          orgId: buyerOrg.id,
          supplierOrgId: supplierOrg.id,
          kind: "PRO_FORMA",
          number: "INV-0001-DEP",
          status: "PAID",
          issuedAt: new Date(),
          paidAt: new Date(),
          subtotalCents: 1_740_000,
          totalCents: 1_740_000,
        },
      });
      await tx.invoice.create({
        data: {
          orderId: order.id,
          subOrderId: subOrder.id,
          orgId: buyerOrg.id,
          supplierOrgId: supplierOrg.id,
          kind: "PRO_FORMA",
          number: "INV-0001-BAL",
          status: "ISSUED",
          dueAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
          subtotalCents: 4_060_000,
          totalCents: 4_060_000,
        },
      });
      await tx.payment.create({
        data: {
          orgId: buyerOrg.id,
          orderId: order.id,
          invoiceId: depositInvoice.id,
          schedule: "DEPOSIT_30_70",
          kind: "DEPOSIT",
          status: "SUCCEEDED",
          amountCents: 1_740_000,
          paidAt: new Date(),
          stripePaymentIntentId: "pi_test_deposit",
          idempotencyKey: "order:deposit:pi_test_deposit",
        },
      });
      await tx.escrowLedgerEntry.create({
        data: {
          orgId: buyerOrg.id,
          orderId: order.id,
          subOrderId: subOrder.id,
          kind: "HOLD",
          amountCents: 1_740_000,
          balanceAfterCents: 1_740_000,
          idempotencyKey: "escrow:hold:deposit",
        },
      });
      await tx.shipment.create({
        data: {
          subOrderId: subOrder.id,
          orgId: supplierOrg.id,
          carrier: "MockFreight",
          trackingNumber: "MF-000123",
          status: "IN_TRANSIT",
          shippedAt: new Date(),
        },
      });

      // ── Comms, workspace, ops ────────────────────────────────────────────
      const thread = await tx.thread.create({
        data: { kind: "ORDER", buyerOrgId: buyerOrg.id, supplierOrgId: supplierOrg.id, orderId: order.id, subject: "Order #1" },
      });
      const message = await tx.message.create({
        data: {
          threadId: thread.id,
          orgId: supplierOrg.id,
          senderUserId: supplierUser.id,
          kind: "TEXT",
          body: "Glass melting scheduled for next week.",
          sourceLanguage: "en",
          translations: { es: "Fundición de vidrio programada para la próxima semana." },
        },
      });
      await tx.messageAttachment.create({
        data: {
          messageId: message.id,
          orgId: supplierOrg.id,
          fileId: "r2/attachments/schedule.pdf",
          filename: "schedule.pdf",
          mimeType: "application/pdf",
          sizeBytes: 48_213,
        },
      });

      const savedList = await tx.savedList.create({
        data: { orgId: buyerOrg.id, ownerUserId: buyerUser.id, name: "Q4 packaging shortlist", isShared: true },
      });
      await tx.savedListItem.create({
        data: { savedListId: savedList.id, orgId: buyerOrg.id, listingId: listing.id, note: "Hot-fill option" },
      });
      const board = await tx.projectBoard.create({ data: { orgId: buyerOrg.id, name: "Sparkling tea launch" } });
      await tx.projectBoardCard.create({
        data: { boardId: board.id, orgId: buyerOrg.id, title: "Bottle selection", stage: "Sourcing", listingId: listing.id, rfqId: rfq.id },
      });
      await tx.orderTemplate.create({
        data: { orgId: buyerOrg.id, name: "Quarterly bottle reorder", listingId: listing.id, listingVariantId: variant.id, quantity: 100_000, notes: "Every 13 weeks" },
      });
      await tx.approvalRequest.create({
        data: {
          orgId: buyerOrg.id,
          requesterUserId: buyerUser.id,
          approverUserId: approverUser.id,
          entityType: "order",
          entityId: order.id,
          amountCents: 5_800_000,
          status: "APPROVED",
          decidedAt: new Date(),
          decisionNote: "Within launch budget",
        },
      });
      await tx.auditLog.create({
        data: {
          orgId: buyerOrg.id,
          actorUserId: buyerUser.id,
          action: "order.created",
          entityType: "Order",
          entityId: order.id,
          after: { status: "DEPOSIT_DUE" },
          ip: "10.0.0.1",
        },
      });
      await tx.analyticsEvent.create({
        data: { orgId: buyerOrg.id, type: "quote.accepted", actorUserId: buyerUser.id, subjectType: "Quote", subjectId: quote.id, properties: { channel: "web" } },
      });
      await tx.priceBenchmark.create({
        data: { categoryId: category.id, qtyBand: "50000-99999", material: "GLASS", sampleCount: 42, medianCents: 41, p25Cents: 36, p75Cents: 47 },
      });
      await tx.featuredPlacement.create({
        data: {
          orgId: supplierOrg.id,
          listingId: listing.id,
          categoryId: category.id,
          kind: "LISTING_BOOST",
          annualAmountCents: 250_000,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
          status: "ACTIVE",
          supplierProfileId: profile.id,
        },
      });
      await tx.webhookDelivery.create({
        data: {
          orgId: buyerOrg.id,
          direction: "OUTBOUND",
          event: "sourcing.project.packaging_stage",
          url: "https://hooks.aekovera.test/projects",
          projectRef: "KURD-001",
          status: "DELIVERED",
          attempts: 1,
          deliveredAt: new Date(),
        },
      });

      return { buyerOrgId: buyerOrg.id, supplierOrgId: supplierOrg.id, orderId: order.id, listingId: listing.id };
    });

    // ── Read back & assert ─────────────────────────────────────────────────
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: ids.orderId },
      include: { invoices: true, payments: true, escrowEntries: true, orderLines: true, subOrders: true },
    });

    // Totals reconcile across order → invoices → payments → escrow, in integer cents.
    const deposit = order.invoices.find((i) => i.number === "INV-0001-DEP");
    const balance = order.invoices.find((i) => i.number === "INV-0001-BAL");
    if (!deposit || !balance) throw new Error("both deposit and balance invoices must exist");
    expect(deposit.totalCents).toBe(1_740_000);
    expect(balance.totalCents).toBe(4_060_000);
    expect(deposit.totalCents + balance.totalCents).toBe(order.totalCents);
    expect(order.commissionBps).toBe(500);

    const paid = order.payments.reduce((sum, p) => sum + p.amountCents, 0);
    expect(paid).toBe(deposit.totalCents);
    expect(order.payments[0]?.idempotencyKey).toBe("order:deposit:pi_test_deposit");

    const escrowHeld = order.escrowEntries
      .filter((e) => e.kind === "HOLD")
      .reduce((sum, e) => sum + e.amountCents, 0);
    expect(escrowHeld).toBe(paid);
    expect(order.escrowEntries[0]?.balanceAfterCents).toBe(paid);

    // Tenancy: rows are orgId-scoped and land in the right tenant.
    expect(order.orgId).toBe(ids.buyerOrgId);
    expect(order.subOrders[0]?.orgId).toBe(ids.supplierOrgId);
    expect(await prisma.listing.count({ where: { orgId: ids.supplierOrgId } })).toBe(1);
    expect(await prisma.listing.count({ where: { orgId: ids.buyerOrgId } })).toBe(0);

    const listing = await prisma.listing.findUniqueOrThrow({
      where: { id: ids.listingId },
      include: {
        variants: true,
        moqTiers: { orderBy: { minQty: "asc" } },
        leadTimes: true,
        complianceClaims: true,
        category: true,
      },
    });
    expect(listing.attributes).toEqual(RIGID_ATTRIBUTES);
    expect(listing.moqTiers.map((t) => t.unitPriceCents)).toEqual([45, 38, 32]);
    expect(listing.category.slug).toBe("rigid");
    expect(listing.variants[0]?.sku).toBe("SKU-12OZ-GLASS");
    expect(listing.leadTimes[0]?.productionDays).toBe(21);
    expect(listing.complianceClaims[0]?.framework).toBe("FDA_21CFR");

    const message = await prisma.message.findFirstOrThrow({ include: { attachments: true } });
    expect(message.translations).toEqual({ es: "Fundición de vidrio programada para la próxima semana." });
    expect(message.attachments[0]?.filename).toBe("schedule.pdf");

    const approval = await prisma.approvalRequest.findFirstOrThrow();
    expect(approval.status).toBe("APPROVED");
    expect(approval.amountCents).toBe(5_800_000);
  });
});

describe("pgvector embeddings", () => {
  it("stores 1536-dim vectors and ranks nearest neighbors by cosine distance", async () => {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: "rigid" } });
    const supplierOrgId = (
      await prisma.organization.findUniqueOrThrow({ where: { slug: "meridian-glassworks" } })
    ).id;

    // Raw SQL is required for Unsupported vector columns (Prisma cannot write
    // them through the typed client).
    const embeddings = [
      { sku: "SKU-A", vector: makeVector({ 0: 1 }) },
      { sku: "SKU-B", vector: makeVector({ 0: 0.9, 1: 0.1 }) },
      { sku: "SKU-C", vector: makeVector({ 2: 1 }) },
    ];
    for (const [i, embedding] of embeddings.entries()) {
      const listing = await prisma.listing.create({
        data: {
          orgId: supplierOrgId,
          categoryId: category.id,
          title: `Listing ${embedding.sku}`,
          slug: `embed-${embedding.sku.toLowerCase()}`,
          status: "LIVE",
          attributes: { material: "GLASS" },
        },
      });
      // updatedAt is client-managed (@updatedAt), so raw SQL must supply it.
      await prisma.$executeRaw`INSERT INTO "ListingEmbedding" (id, "listingId", "orgId", kind, model, dimensions, embedding, "textPreview", "updatedAt")
        VALUES (${"emb-" + String(i)}, ${listing.id}, ${supplierOrgId}, 'TITLE', 'mock-embedding-adapter', 1536, ${embedding.vector}::vector, ${"preview " + String(i)}, now())`;
    }

    // The HNSW cosine index from the init migration.
    const hnsw = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'ListingEmbedding' AND indexname = 'ListingEmbedding_embedding_hnsw'`;
    expect(hnsw).toHaveLength(1);

    // Nearest to A: B (cosine ≈ 0.005) then C (orthogonal, distance 1).
    const ranked = await prisma.$queryRaw<{ slug: string }[]>`
      SELECT l.slug FROM "ListingEmbedding" le
      JOIN "Listing" l ON l.id = le."listingId"
      ORDER BY le.embedding <=> ${embeddings[0]?.vector ?? makeVector({ 0: 1 })}::vector
      LIMIT 3`;
    expect(ranked.map((r) => r.slug)).toEqual(["embed-sku-a", "embed-sku-b", "embed-sku-c"]);
  });
});
