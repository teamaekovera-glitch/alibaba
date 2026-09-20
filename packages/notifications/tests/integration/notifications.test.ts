import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@packsource/db";
import type { AuthContext } from "@packsource/core";
import {
  MockNotificationEmailAdapter,
  NotificationEngine,
  NotificationRecipientError,
  NotificationRepository,
  runReorderReminderSweep,
} from "../../src/index";

/**
 * The notification system against a real pgvector Postgres: the engine's
 * in-app/email/audit legs, the user-scoped notification center, and the
 * deterministic reorder-reminder sweep (PR #11's ReorderRule cadence) —
 * including its replay no-op guarantee.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://packsource:packsource@localhost:5432/packsource_test";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dbPkgRoot = path.resolve(pkgRoot, "../db");

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

let owner!: { id: string; org: { id: string } };
let member!: { id: string; org: { id: string } };
let outsider!: { id: string; org: { id: string } };

function authFor(person: { id: string; org: { id: string } }, role: AuthContext["role"]): AuthContext {
  return { userId: person.id, orgId: person.org.id, role };
}

let email: MockNotificationEmailAdapter;

const engineFor = (actor: { userId: string | null } = { userId: null }) =>
  new NotificationEngine(prisma, email, {
    actorType: actor.userId ? "user" : "system",
    userId: actor.userId,
  });

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
  email = new MockNotificationEmailAdapter();

  const ownerUser = await prisma.user.create({ data: { email: "notify-owner@int.test" } });
  const memberUser = await prisma.user.create({ data: { email: "notify-member@int.test" } });
  const outsiderUser = await prisma.user.create({ data: { email: "notify-outsider@int.test" } });
  const org = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Notifications Buyer Co (integration)",
      slug: "notifications-buyer-int",
      members: {
        create: [
          { userId: ownerUser.id, role: "BUYER" },
          { userId: memberUser.id, role: "BUYER" },
        ],
      },
    },
  });
  const otherOrg = await prisma.organization.create({
    data: {
      type: "BUYER",
      name: "Unrelated Buyer Co (integration)",
      slug: "notifications-unrelated-int",
      members: { create: { userId: outsiderUser.id, role: "BUYER" } },
    },
  });
  owner = { id: ownerUser.id, org: { id: org.id } };
  member = { id: memberUser.id, org: { id: org.id } };
  outsider = { id: outsiderUser.id, org: { id: otherOrg.id } };

  const category = await prisma.category.create({
    data: { name: "Notifications Mailers", slug: "notifications-mailers", attributeSet: {} },
  });
  await prisma.listing.create({
    data: {
      orgId: org.id,
      categoryId: category.id,
      title: "Kraft Mailer (notifications flow)",
      slug: "notifications-flow-mailer",
      status: "LIVE",
      publishedAt: new Date(),
      attributes: {},
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("sends one notification per recipient with in-app rows, emails, and an audit event", async () => {
  const at = new Date("2026-05-01T12:00:00.000Z");
  email.reset();
  const result = await engineFor({ userId: owner.id }).notify({
    orgId: owner.org.id,
    userIds: [owner.id, member.id],
    kind: "DISPUTE_OPENED",
    title: "Order update",
    body: "Your order moved to production.",
    linkUrl: "/orders",
    entityType: "Order",
    entityId: "order_test_1",
    now: at,
  });

  expect(result.notificationIds).toHaveLength(2);
  expect(result.emails).toHaveLength(2);
  const rows = await prisma.notification.findMany({
    where: { entityType: "Order", entityId: "order_test_1" },
    orderBy: { userId: "asc" },
  });
  expect(rows.map((row) => row.userId)).toEqual([member.id, owner.id].sort());
  for (const row of rows) {
    expect(row).toMatchObject({ kind: "DISPUTE_OPENED", readAt: null, linkUrl: "/orders" });
  }
  // Email leg mirrors the in-app fan-out, one per recipient.
  expect(email.outbox().map((mail) => mail.to).sort()).toEqual(
    ["notify-member@int.test", "notify-owner@int.test"].sort(),
  );
  // Every send is auditable: one notification.sent row per recipient under
  // the acting user, with the channel list in the after payload.
  const audits = await prisma.auditLog.findMany({ where: { action: "notification.sent" } });
  expect(audits).toHaveLength(2);
  for (const audit of audits) {
    expect(audit).toMatchObject({ orgId: owner.org.id, actorUserId: owner.id, actorType: "user" });
    expect((audit.after as { channels: string[] }).channels).toEqual(["in_app", "email"]);
  }
});

it("deduplicates recipients and refuses unknown users", async () => {
  email.reset();
  const dup = await engineFor({ userId: owner.id }).notify({
    orgId: owner.org.id,
    userIds: [member.id, member.id],
    kind: "DISPUTE_OPENED",
    title: "Dedup check",
    body: "One row, not two.",
    entityType: "Order",
    entityId: "order_dedup",
    now: new Date("2026-05-01T12:01:00.000Z"),
  });
  expect(dup.notificationIds).toHaveLength(1);

  await expect(
    engineFor({ userId: owner.id }).notify({
      orgId: owner.org.id,
      userIds: ["user_does_not_exist", outsider.id],
      kind: "DISPUTE_OPENED",
      title: "Ghost",
      body: "Unknown recipient",
      entityType: "Order",
      entityId: "order_ghost",
      now: new Date("2026-05-01T12:02:00.000Z"),
    }),
  ).rejects.toThrow(NotificationRecipientError);
  // The failed fan-out added nothing to the outbox (the dedup leg's single
  // send above was reset away first).
  email.reset();
  expect(email.outbox()).toHaveLength(0);
});

it("skips the email leg when the send opts out but keeps the in-app row", async () => {
  email.reset();
  const optOut = await prisma.user.create({ data: { email: "notify-optout@int.test" } });
  await prisma.orgMembership.create({ data: { orgId: owner.org.id, userId: optOut.id, role: "BUYER" } });

  const result = await engineFor({ userId: owner.id }).notify({
    orgId: owner.org.id,
    userIds: [optOut.id],
    kind: "DISPUTE_OPENED",
    title: "Opt-out check",
    body: "In-app only.",
    entityType: "Order",
    entityId: "order_optout",
    email: { enabled: false },
    now: new Date("2026-05-01T12:03:00.000Z"),
  });
  expect(result.notificationIds).toHaveLength(1);
  expect(result.emails).toHaveLength(0);
  expect(email.outbox()).toHaveLength(0);
  expect(await prisma.notification.findFirst({ where: { userId: optOut.id } })).not.toBeNull();
});

describe("notification center", () => {
  it("is strictly user-scoped and counts unread", async () => {
    const inbox = new NotificationRepository(prisma, authFor(owner, "BUYER"));
    const others = new NotificationRepository(prisma, authFor(outsider, "BUYER"));

    const mine = await inbox.list();
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((row) => row.userId === owner.id)).toBe(true);
    // The outsider sees none of the first org's notifications.
    expect(await others.list()).toEqual([]);

    const first = mine[0]!;
    const before = await inbox.unreadCount();
    expect(before).toBeGreaterThanOrEqual(1);
    const marked = await inbox.markRead(first.id);
    expect(marked.readAt).not.toBeNull();
    // Idempotent: marking again does not change the row's readAt.
    const again = await inbox.markRead(first.id);
    expect(again.readAt).toEqual(marked.readAt);
    expect(await inbox.unreadCount()).toBe(before - 1);
  });

  it("refuses cross-user reads and marks all read", async () => {
    const inbox = new NotificationRepository(prisma, authFor(owner, "BUYER"));
    const others = new NotificationRepository(prisma, authFor(outsider, "BUYER"));

    const mine = await inbox.list();
    const first = mine[0]!;
    await expect(others.markRead(first.id)).rejects.toThrow(); // RecordNotFoundError

    const marked = await inbox.markAllRead();
    expect(marked).toBe(mine.filter((row) => row.readAt === null).length);
    expect(await inbox.unreadCount()).toBe(0);
  });

  it("honors the unread-only filter", async () => {
    const inbox = new NotificationRepository(prisma, authFor(owner, "BUYER"));
    const unreadOnly = await inbox.list({ unreadOnly: true });
    expect(unreadOnly).toEqual([]);
  });
});

describe("reorder reminder sweep (PR #11 ReorderRule contract)", () => {
  it("reminds due rules, advances cadence, audits, and is a no-op on replay", async () => {
    const listing = await prisma.listing.findUniqueOrThrow({
      where: { slug: "notifications-flow-mailer" },
    });
    const now = new Date("2026-05-02T09:00:00.000Z");
    // Dedicated org + member: the sweep counts must not depend on how many
    // members earlier tests added to the fixture org.
    const sweepUser = await prisma.user.create({ data: { email: "notify-sweep@int.test" } });
    const sweepOrg = await prisma.organization.create({
      data: {
        type: "BUYER",
        name: "Sweep Buyer Co (integration)",
        slug: "notifications-sweep-int",
        members: { create: { userId: sweepUser.id, role: "BUYER" } },
      },
    });
    const dueRule = await prisma.reorderRule.create({
      data: { orgId: sweepOrg.id, listingId: listing.id, cadenceDays: 30, nextOrderAt: new Date(now.getTime() - 1) },
    });
    const futureRule = await prisma.reorderRule.create({
      data: {
        orgId: sweepOrg.id,
        listingId: listing.id,
        cadenceDays: 90,
        nextOrderAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      },
    });
    const inactive = await prisma.reorderRule.create({
      data: {
        orgId: sweepOrg.id,
        listingId: listing.id,
        cadenceDays: 30,
        nextOrderAt: new Date(now.getTime() - 1),
        isActive: false,
      },
    });
    email.reset();
    const before = await prisma.notification.count({ where: { kind: "REORDER_REMINDER" } });

    const result = await runReorderReminderSweep(prisma, email, now);
    expect(result).toMatchObject({ rulesReminded: 1, notificationsSent: 1, emailsSent: 1 });

    // In-app + email fan-out to the rule org's members, audited as reorder.remind.
    const reminded = await prisma.notification.count({
      where: { kind: "REORDER_REMINDER", entityType: "ReorderRule", entityId: dueRule.id },
    });
    expect(reminded).toBe(1);
    expect(email.outbox().map((mail) => mail.to)).toEqual(["notify-sweep@int.test"]);
    const sweepAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "reorder.remind", entityId: dueRule.id },
    });
    expect(sweepAudit.actorType).toBe("system");
    expect(sweepAudit.actorUserId).toBeNull();

    // Cadence advanced exactly one cycle; future/inactive rules untouched.
    const advanced = await prisma.reorderRule.findUniqueOrThrow({ where: { id: dueRule.id } });
    expect(advanced.nextOrderAt!.getTime()).toBe(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(
      (await prisma.reorderRule.findUniqueOrThrow({ where: { id: futureRule.id } })).nextOrderAt!.getTime(),
    ).toBe(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    expect(
      (await prisma.reorderRule.findUniqueOrThrow({ where: { id: inactive.id } })).nextOrderAt!.getTime(),
    ).toBe(now.getTime() - 1);

    // Replay at the same instant: the moved-forward rule is no longer due.
    const replay = await runReorderReminderSweep(prisma, email, now);
    expect(replay).toMatchObject({ rulesReminded: 0, notificationsSent: 0, emailsSent: 0 });
    expect(await prisma.notification.count({ where: { kind: "REORDER_REMINDER" } })).toBe(before + 1);
  });
});
