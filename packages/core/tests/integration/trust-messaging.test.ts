import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import {
  MessagingError,
  MessagingRepository,
  MESSAGING_AUDIT,
  RecordNotFoundError,
  type AuthContext,
} from "../../src/index";

/**
 * General messaging integration (spec: "Trust & comms — messaging"):
 * ORDER/SUPPORT threads on the shared Thread/Message models, write+read
 * contact redaction, unread counting, composite-keyset pagination, org
 * tenancy, the contact-sharing unlock policy, and audit events for every
 * sensitive action — against a real pgvector Postgres.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

let buyer!: { id: string; org: { id: string } };
let otherBuyer!: { id: string; org: { id: string } };
let supplier!: { id: string; org: { id: string } };
let staff!: { id: string; org: { id: string } };

function authFor(person: { id: string; org: { id: string } }, role: AuthContext["role"]): AuthContext {
  return { userId: person.id, orgId: person.org.id, role };
}

const messagingAs = (person: { id: string; org: { id: string } }, role: AuthContext["role"]) =>
  new MessagingRepository(prisma, authFor(person, role));
const buyerMessaging = () => messagingAs(buyer, "BUYER");
const otherBuyerMessaging = () => messagingAs(otherBuyer, "BUYER");
const supplierMessaging = () => messagingAs(supplier, "SUPPLIER_SALES");
const staffMessaging = () => messagingAs(staff, "AEKOVERA_STAFF");

/** Minimal order with one supplier leg, for ORDER threads and counters. */
async function createOrder(input: {
  buyerOrgId: string;
  buyerUserId: string;
  supplierOrgId: string;
  status?: "DRAFT" | "DELIVERED";
}) {
  return prisma.order.create({
    data: {
      orgId: input.buyerOrgId,
      buyerUserId: input.buyerUserId,
      status: input.status ?? "DRAFT",
      paymentSchedule: "FULL_PREPAY",
      subOrders: { create: { orgId: input.supplierOrgId, status: "PENDING" } },
    },
  });
}

beforeAll(() => {
  execSync("npx prisma migrate deploy", {
    cwd: dbPkgRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
  return prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Organization", "User", "AuditLog", "Thread", "ThreadReadState", "Order" CASCADE`,
  );
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeAll(async () => {
  const buyerUser = await prisma.user.create({ data: { email: "messaging-buyer@int.test" } });
  const buyerOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Messaging Buyer Co (integration)",
      slug: "messaging-buyer-int",
      members: { create: { userId: buyerUser.id, role: "BUYER" } },
    },
  });
  buyer = { id: buyerUser.id, org: { id: buyerOrg.id } };

  const otherUser = await prisma.user.create({ data: { email: "messaging-other@int.test" } });
  const otherOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Messaging Unrelated Co (integration)",
      slug: "messaging-unrelated-int",
      members: { create: { userId: otherUser.id, role: "BUYER" } },
    },
  });
  otherBuyer = { id: otherUser.id, org: { id: otherOrg.id } };

  const supplierUser = await prisma.user.create({ data: { email: "messaging-supplier@int.test" } });
  const supplierOrg = await prisma.organization.create({
    data: {
      type: "SUPPLIER",
      name: "Messaging Supplier Co (integration)",
      slug: "messaging-supplier-int",
      billingEmail: "front-desk@messagesupplier.test",
      members: { create: { userId: supplierUser.id, role: "SUPPLIER_SALES" } },
    },
  });
  supplier = { id: supplierUser.id, org: { id: supplierOrg.id } };

  const staffUser = await prisma.user.create({ data: { email: "messaging-staff@int.test" } });
  const platformOrg = await prisma.organization.create({
    data: {
      type: "PLATFORM",
      name: "Aekovera (messaging integration)",
      slug: "aekovera-messaging-int",
      members: { create: { userId: staffUser.id, role: "AEKOVERA_STAFF" } },
    },
  });
  staff = { id: staffUser.id, org: { id: platformOrg.id } };
});

describe("messaging: thread creation", () => {
  it("starts an ORDER thread from the buyer side, deriving the supplier from the order", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    const { thread, message } = await buyerMessaging().startThread({
      kind: "ORDER",
      orderId: order.id,
      body: "Can we switch the mailer to kraft inside? Reach me at buyer@channel.test / +1 555 010 9876.",
    });
    expect(thread.kind).toBe("ORDER");
    expect(thread.buyerOrgId).toBe(buyer.org.id);
    expect(thread.supplierOrgId).toBe(supplier.org.id);
    expect(thread.orderId).toBe(order.id);
    // Redacted on WRITE: the email and phone never reach the database. (A
    // two-group "555-0100" stays raw by design — the pattern must not eat
    // quantity ranges like "50-100" — so the test uses a 3-group number.)
    expect(message.body).toContain("Can we switch the mailer");
    expect(message.body).not.toContain("buyer@channel.test");
    expect(message.body).not.toContain("555 010 9876");

    const stored = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(stored.body).not.toContain("buyer@channel.test");
  });

  it("starts an ORDER thread from the supplier side of the same order", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    const { thread } = await supplierMessaging().startThread({
      kind: "ORDER",
      orderId: order.id,
      body: "Heads up: plate charges can be waived at 5,000 units.",
    });
    expect(thread.buyerOrgId).toBe(buyer.org.id);
    expect(thread.supplierOrgId).toBe(supplier.org.id);
  });

  it("refuses ORDER threads on orders the acting org is not part of", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    await expect(
      otherBuyerMessaging().startThread({ kind: "ORDER", orderId: order.id, body: "let me in" }),
    ).rejects.toThrow(RecordNotFoundError);
  });

  it("starts a SUPPORT thread with an explicit counterparty and rejects buyer-buyer pairs", async () => {
    const { thread } = await buyerMessaging().startThread({
      kind: "SUPPORT",
      counterpartyOrgId: supplier.org.id,
      subject: "Sample request for Q4",
      body: "Do you run 4-color flexo on 350gsm?",
    });
    expect(thread.kind).toBe("SUPPORT");
    await expect(
      otherBuyerMessaging().startThread({ kind: "SUPPORT", counterpartyOrgId: buyer.org.id, subject: "hi" }),
    ).rejects.toThrow(MessagingError);
  });

  it("reserves the RFQ thread kind for the RFQ engine", async () => {
    await expect(
      buyerMessaging().startThread({
        kind: "RFQ" as never,
        counterpartyOrgId: supplier.org.id,
        subject: "sneaky",
      }),
    ).rejects.toThrow(MessagingError);
  });

  it("requires a subject, body, or attachment", async () => {
    await expect(
      buyerMessaging().startThread({ kind: "SUPPORT", counterpartyOrgId: supplier.org.id }),
    ).rejects.toThrow(MessagingError);
  });
});

describe("messaging: posting and reading", () => {
  it("posts, serializes oldest-first, paginates with composite cursors, and re-redacts on read", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    const { thread } = await buyerMessaging().startThread({
      kind: "ORDER",
      orderId: order.id,
      body: "first",
    });
    for (const body of ["second", "third", "fourth", "fifth"]) {
      await supplierMessaging().postMessage(thread.id, { body });
    }
    // A raw row with contact details (pre-policy data) still cannot leak via reads.
    await prisma.message.create({
      data: { threadId: thread.id, orgId: supplier.org.id, kind: "TEXT", body: "raw row: ops@channel.test" },
    });

    const pageOne = await buyerMessaging().threadMessages(thread.id, { limit: 3 });
    expect(pageOne.messages.map((message) => message.body)).toEqual([
      "fourth",
      "fifth",
      "raw row: [contact info removed]",
    ]);
    expect(pageOne.nextBefore).toBeDefined();

    const pageTwo = await buyerMessaging().threadMessages(thread.id, {
      limit: 3,
      before: pageOne.nextBefore,
    });
    expect(pageTwo.messages.map((message) => message.body)).toEqual(["first", "second", "third"]);
    expect(pageTwo.nextBefore).toBeUndefined();
  });

  it("supports attachments as FILE messages", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    const { thread } = await buyerMessaging().startThread({
      kind: "ORDER",
      orderId: order.id,
      attachments: [
        { fileId: "mock/dieline.pdf", filename: "dieline.pdf", mimeType: "application/pdf", sizeBytes: 1024 },
      ],
    });
    const page = await buyerMessaging().threadMessages(thread.id, { limit: 10 });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.kind).toBe("FILE");
    expect(page.messages[0]?.attachments[0]?.filename).toBe("dieline.pdf");
  });

  it("requires a body or attachment on posts and rejects non-participants", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    const { thread } = await buyerMessaging().startThread({ kind: "ORDER", orderId: order.id, body: "start" });
    await expect(supplierMessaging().postMessage(thread.id, {})).rejects.toThrow(MessagingError);
    await expect(otherBuyerMessaging().postMessage(thread.id, { body: "drive-by" })).rejects.toThrow(
      RecordNotFoundError,
    );
    await expect(staffMessaging().postMessage(thread.id, { body: "staff drive-by" })).rejects.toThrow(
      RecordNotFoundError,
    );
  });
});

describe("messaging: unread counts and read state", () => {
  it("counts only inbound messages after the read cursor and clears on markRead", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    const { thread } = await buyerMessaging().startThread({ kind: "ORDER", orderId: order.id, body: "hi" });
    await supplierMessaging().postMessage(thread.id, { body: "one" });
    await supplierMessaging().postMessage(thread.id, { body: "two" });

    const before = await buyerMessaging().listThreads();
    expect(before.threads.find((t) => t.id === thread.id)?.unreadCount).toBe(2);

    await buyerMessaging().markRead(thread.id);
    const after = await buyerMessaging().listThreads();
    expect(after.threads.find((t) => t.id === thread.id)?.unreadCount).toBe(0);

    // The supplier's unread counts only inbound: the buyer's opener is still
    // unread for them (their own two messages never count).
    const supplierView = await supplierMessaging().listThreads();
    expect(supplierView.threads.find((t) => t.id === thread.id)?.unreadCount).toBe(1);
    await supplierMessaging().markRead(thread.id);
    const supplierAfter = await supplierMessaging().listThreads();
    expect(supplierAfter.threads.find((t) => t.id === thread.id)?.unreadCount).toBe(0);
  });
});

describe("messaging: contact-sharing policy", () => {
  it("stays locked for an unverified buyer with no delivered orders on a SUPPORT thread", async () => {
    const { thread } = await buyerMessaging().startThread({
      kind: "SUPPORT",
      counterpartyOrgId: supplier.org.id,
      subject: "pre-order chat",
    });
    const policy = await supplierMessaging().contactPolicy(thread.id);
    expect(policy.canShareContacts).toBe(false);
    expect(policy.contact).toBeNull();
  });

  it("unlocks on ORDER threads and surfaces the counterparty org contact", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    const { thread } = await buyerMessaging().startThread({ kind: "ORDER", orderId: order.id, body: "hello" });
    const policy = await supplierMessaging().contactPolicy(thread.id);
    expect(policy.canShareContacts).toBe(true);
    expect(policy.contact?.orgId).toBe(buyer.org.id);
    expect(policy.contact?.orgName).toBe("Messaging Buyer Co (integration)");
  });

  it("unlocks for an AEKOVERA_VETTED buyer org via its SupplierProfile, before any orders", async () => {
    const vettedUser = await prisma.user.create({ data: { email: "messaging-vetted@int.test" } });
    const vettedOrg = await prisma.organization.create({
      data: {
        type: "BUYER",
        name: "Vetted Buyer Co (integration)",
        slug: "messaging-vetted-int",
        members: { create: { userId: vettedUser.id, role: "BUYER" } },
        // Buyer orgs carry verification on their (optional) SupplierProfile.
        supplierProfile: { create: { verificationStatus: "AEKOVERA_VETTED" } },
      },
    });
    const vetted = { id: vettedUser.id, org: { id: vettedOrg.id } };
    const { thread } = await messagingAs(vetted, "BUYER").startThread({
      kind: "SUPPORT",
      counterpartyOrgId: supplier.org.id,
      subject: "vetted buyer chat",
    });
    const policy = await supplierMessaging().contactPolicy(thread.id);
    expect(policy.canShareContacts).toBe(true);
    expect(policy.contact?.orgId).toBe(vettedOrg.id);
  });

  it("unlocks for an unverified buyer with three delivered orders, per the policy floor", async () => {
    const verifiedUser = await prisma.user.create({ data: { email: "messaging-verified@int.test" } });
    const verifiedOrg = await prisma.organization.create({
      data: {
        type: "BUYER",
        name: "Verified Buyer Co (integration)",
        slug: "messaging-verified-int",
        members: { create: { userId: verifiedUser.id, role: "BUYER" } },
      },
    });
    for (let index = 0; index < 3; index += 1) {
      await createOrder({
        buyerOrgId: verifiedOrg.id,
        buyerUserId: verifiedUser.id,
        supplierOrgId: supplier.org.id,
        status: "DELIVERED",
      });
    }
    const verified = { id: verifiedUser.id, org: { id: verifiedOrg.id } };
    const { thread } = await messagingAs(verified, "BUYER").startThread({
      kind: "SUPPORT",
      counterpartyOrgId: supplier.org.id,
      subject: "verified buyer chat",
    });
    const policy = await supplierMessaging().contactPolicy(thread.id);
    expect(policy.canShareContacts).toBe(true);
    expect(policy.contact?.orgId).toBe(verifiedOrg.id);
  });
});

describe("messaging: audit events", () => {
  it("writes thread_create, message, and mark_read audit events", async () => {
    const order = await createOrder({
      buyerOrgId: buyer.org.id,
      buyerUserId: buyer.id,
      supplierOrgId: supplier.org.id,
    });
    const { thread } = await buyerMessaging().startThread({ kind: "ORDER", orderId: order.id, body: "audit me" });
    await buyerMessaging().postMessage(thread.id, { body: "again" });
    await buyerMessaging().markRead(thread.id);

    const actions = (
      await prisma.auditLog.findMany({ where: { orgId: buyer.org.id }, orderBy: { createdAt: "asc" } })
    ).map((row) => row.action);
    expect(actions).toContain(MESSAGING_AUDIT.threadCreate);
    expect(actions).toContain(MESSAGING_AUDIT.message);
    expect(actions).toContain(MESSAGING_AUDIT.markRead);
  });
});
