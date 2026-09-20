import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import {
  MAX_DELIVERY_ATTEMPTS,
  SIGNATURE_HEADER,
  MockWebhookTransport,
  attachRefToOrder,
  backoffMs,
  captureInboundRef,
  dispatchEvent,
  parseInboundRef,
  retryDueDeliveries,
  verifySignature,
  type WebhookEndpoint,
} from "../../src";

/**
 * DB-backed dispatcher + attribution flows against the local PostgreSQL
 * instance (self-sufficient in CI, which starts from an empty database).
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Migrations live in @packsource/db — run its prisma CLI there.
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const NOW = new Date("2026-09-20T12:00:00.000Z");
const ENDPOINT: WebhookEndpoint = { url: "https://os.example.com/hooks/packsource", secret: "whsec_test_secret" };

let buyerOrg!: { id: string };
let buyerUser!: { id: string };
let otherOrg!: { id: string };

function endpoints(url: string = ENDPOINT.url): Map<string, WebhookEndpoint> {
  return new Map([[url, { ...ENDPOINT, url }]]);
}

beforeAll(() => {
  // CI's service container starts empty — apply the committed migrations here.
  execSync("npx prisma migrate deploy", {
    cwd: dbPkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "WebhookDelivery", "AekoveraProjectRef", "Order", "Organization", "User" CASCADE`,
  );
}, 30_000);

beforeAll(async () => {
  const [user, otherUser] = await Promise.all([
    prisma.user.create({ data: { email: "integrations-buyer@example.com" } }),
    prisma.user.create({ data: { email: "integrations-other@example.com" } }),
  ]);
  buyerUser = user;
  const [org, other] = await Promise.all([
    prisma.organization.create({
      data: { type: "BUYER", name: "Integrations Buyer Org", slug: "integrations-buyer-org", members: { create: { userId: user.id, role: "OWNER" } } },
    }),
    prisma.organization.create({
      data: { type: "BUYER", name: "Integrations Other Org", slug: "integrations-other-org", members: { create: { userId: otherUser.id, role: "OWNER" } } },
    }),
  ]);
  buyerOrg = org;
  otherOrg = other;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("outbound webhook dispatcher", () => {
  it("delivers a signed payload and persists the delivery record", async () => {
    const transport = new MockWebhookTransport();
    const outcome = await dispatchEvent(prisma, transport, {
      event: "escrow.release",
      orgId: buyerOrg.id,
      entityType: "Order",
      entityId: "ord_integration_1",
      data: { totalCents: 42_000 },
      now: NOW,
      endpoints: [ENDPOINT],
    });

    expect(outcome.failed).toHaveLength(0);
    expect(outcome.deliveries).toHaveLength(1);
    const delivery = outcome.deliveries[0]!;
    expect(delivery.status).toBe("DELIVERED");
    expect(delivery.attempts).toBe(1);
    expect(delivery.deliveredAt).toEqual(NOW);
    expect(delivery.event).toBe("escrow.release");
    expect(delivery.url).toBe(ENDPOINT.url);

    // The transport received exactly the persisted payload, properly signed.
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url).toBe(ENDPOINT.url);
    const body = call.body;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: "escrow.release",
      orgId: buyerOrg.id,
      entityType: "Order",
      entityId: "ord_integration_1",
      data: { totalCents: 42_000 },
      occurredAt: NOW.toISOString(),
    });
    const signature = call.headers[SIGNATURE_HEADER];
    expect(signature).toBeDefined();
    expect(verifySignature(ENDPOINT.secret, body, signature!, Math.floor(NOW.getTime() / 1000)).ok).toBe(true);

    // The persisted row carries the same payload that was signed.
    const persisted = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    expect(persisted?.status).toBe("DELIVERED");
    expect(persisted?.payload).toMatchObject({ event: "escrow.release" });
  });

  it("treats a replayed domain event as a no-op", async () => {
    const transport = new MockWebhookTransport();
    const input = {
      event: "order.place" as const,
      orgId: buyerOrg.id,
      entityType: "Order",
      entityId: "ord_integration_replay",
      data: {},
      now: NOW,
      endpoints: [ENDPOINT],
    };
    const first = await dispatchEvent(prisma, transport, input);
    const second = await dispatchEvent(prisma, transport, { ...input, now: new Date(NOW.getTime() + 1000) });

    expect(transport.calls).toHaveLength(1); // no second HTTP attempt
    expect(second.deliveries[0]!.id).toBe(first.deliveries[0]!.id);
    const rows = await prisma.webhookDelivery.findMany({
      where: { event: "order.place", url: ENDPOINT.url },
    });
    expect(rows).toHaveLength(1);
  });

  it("schedules an exponential retry when delivery fails", async () => {
    const transport = new MockWebhookTransport(500, 1); // first attempt fails
    const outcome = await dispatchEvent(prisma, transport, {
      event: "order.ship",
      orgId: buyerOrg.id,
      entityType: "Shipment",
      entityId: "shp_integration_1",
      now: NOW,
      endpoints: [ENDPOINT],
    });

    const delivery = outcome.deliveries[0]!;
    expect(delivery.status).toBe("RETRYING");
    expect(delivery.attempts).toBe(1);
    expect(delivery.nextRetryAt).toEqual(new Date(NOW.getTime() + backoffMs(1)));
    expect(delivery.responseStatus).toBe(500);
    expect(delivery.lastError).toContain("mock transport failure");
  });

  it("exhausts retries and marks the delivery FAILED", async () => {
    const transport = new MockWebhookTransport(503, 99); // always fails
    const outcome = await dispatchEvent(prisma, transport, {
      event: "payment.failed",
      orgId: buyerOrg.id,
      entityType: "Payment",
      entityId: "pay_integration_1",
      now: NOW,
      endpoints: [ENDPOINT],
    });
    expect(outcome.deliveries[0]!.status).toBe("RETRYING");
    expect(outcome.deliveries[0]!.attempts).toBe(1);

    let current = outcome.deliveries[0]!;
    let now = NOW;
    for (let attempt = 2; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      now = new Date(now.getTime() + backoffMs(attempt - 1));
      const results = await retryDueDeliveries(prisma, transport, endpoints(), now);
      const retried = results.find((r) => r.id === current.id);
      expect(retried).toBeDefined();
      current = retried!;
    }

    expect(current.status).toBe("FAILED");
    expect(current.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(current.nextRetryAt).toBeNull();

    // Fully exhausted: the sweep has nothing left to do.
    const swept = await retryDueDeliveries(prisma, transport, endpoints(), new Date(now.getTime() + 60_000));
    expect(swept).toHaveLength(0);
  });

  it("only retries deliveries whose backoff window has elapsed", async () => {
    const transport = new MockWebhookTransport(500, 1);
    const outcome = await dispatchEvent(prisma, transport, {
      event: "quote.decline",
      orgId: buyerOrg.id,
      entityType: "Quote",
      entityId: "quo_integration_1",
      now: NOW,
      endpoints: [ENDPOINT],
    });

    const tooEarly = await retryDueDeliveries(prisma, transport, endpoints(), new Date(NOW.getTime() + 1));
    expect(tooEarly.find((d) => d.id === outcome.deliveries[0]!.id)).toBeUndefined();

    const due = await retryDueDeliveries(prisma, transport, endpoints(), new Date(NOW.getTime() + backoffMs(1)));
    const mine = due.find((d) => d.id === outcome.deliveries[0]!.id);
    expect(mine?.status).toBe("DELIVERED");
  });

  it("rejects events outside the audit-derived catalog", async () => {
    const transport = new MockWebhookTransport();
    await expect(
      dispatchEvent(prisma, transport, {
        event: "made.up.event" as never,
        orgId: buyerOrg.id,
        entityType: "Order",
        entityId: "ord_integration_2",
        now: NOW,
        endpoints: [ENDPOINT],
      }),
    ).rejects.toThrow(/unknown webhook event/);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("inbound Aekovera OS attribution", () => {
  it("captures a project ref idempotently and updates the brand ref", async () => {
    const first = await captureInboundRef(prisma, {
      orgId: buyerOrg.id,
      projectRef: "proj_integration_1",
      brandOrgRef: "brand_1",
    });
    const replay = await captureInboundRef(prisma, {
      orgId: buyerOrg.id,
      projectRef: "proj_integration_1",
      brandOrgRef: "brand_1",
    });
    expect(replay.id).toBe(first.id);
    const rows = await prisma.aekoveraProjectRef.findMany({
      where: { orgId: buyerOrg.id, projectRef: "proj_integration_1" },
    });
    expect(rows).toHaveLength(1);

    const updated = await captureInboundRef(prisma, {
      orgId: buyerOrg.id,
      projectRef: "proj_integration_1",
      brandOrgRef: "brand_2",
    });
    expect(updated.id).toBe(first.id);
    expect(updated.brandOrgRef).toBe("brand_2");
  });

  it("attaches a ref to an order idempotently and refuses cross-org refs", async () => {
    const order = await prisma.order.create({
      data: {
        orgId: buyerOrg.id,
        buyerUserId: buyerUser.id,
        paymentSchedule: "FULL_PREPAY",
      },
    });
    const ref = await captureInboundRef(prisma, { orgId: buyerOrg.id, projectRef: "proj_integration_order" });

    await attachRefToOrder(prisma, order.id, ref.id);
    await attachRefToOrder(prisma, order.id, ref.id); // idempotent

    const attached = await prisma.order.findUnique({ where: { id: order.id } });
    expect(attached?.aekoveraProjectRefId).toBe(ref.id);

    const foreignRef = await captureInboundRef(prisma, { orgId: otherOrg.id, projectRef: "proj_foreign" });
    await expect(attachRefToOrder(prisma, order.id, foreignRef.id)).rejects.toThrow(/different org/);
  });

  it("parses inbound refs with the header taking precedence over the query", () => {
    const headerUrl = "https://packsource.example.com/landing?ref=from_query";
    const request = new Request(headerUrl, { headers: { "x-aekovera-project-ref": "from_header" } });
    expect(parseInboundRef(request)).toBe("from_header");

    const queryOnly = new Request("https://packsource.example.com/landing?ref=from_query");
    expect(parseInboundRef(queryOnly)).toBe("from_query");

    expect(parseInboundRef(new Request("https://packsource.example.com/landing"))).toBeNull();
  });
});
