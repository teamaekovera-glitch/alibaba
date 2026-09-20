/**
 * Reorder reminder sweep (spec: "reorder rules (cadence + production
 * schedule)" — the Inngest job's mock twin). Finds every active rule whose
 * nextOrderAt has passed, sends each member of the rule's org an in-app
 * notification plus a mock email, and pushes the rule's nextOrderAt out by
 * its own cadence — the exact state transition PR #11's ReorderRepository
 * performs on user-triggered reminders, here under the system actor. The
 * clock is always a parameter: double-runs at the same `now` are no-ops
 * (nextOrderAt moved forward), which makes replays and tests deterministic.
 */
import { Prisma, type PrismaClient } from "@packsource/db";
import { addDays, REORDER_AUDIT } from "@packsource/core";
import type { NotificationEmailPort } from "./email";
import { NotificationEngine, type NotificationActor } from "./notification-engine";

/** The sweep's actor: the platform operating its reminder job, not a role. */
export const NOTIFICATIONS_SYSTEM_ACTOR: NotificationActor = {
  actorType: "system",
  userId: null,
};

/** Pure content builder — unit-testable without a database. */
export function reorderReminderContent(
  listingTitle: string,
  cadenceDays: number,
  nextOrderAt: Date,
): { title: string; body: string; linkUrl: string } {
  return {
    title: `Reorder due: ${listingTitle}`,
    body: `This item is due on your ${cadenceDays}-day reorder cadence (was scheduled for ${nextOrderAt.toISOString().slice(0, 10)}).`,
    linkUrl: "/orders",
  };
}

export interface ReorderSweepResult {
  rulesReminded: number;
  notificationsSent: number;
  emailsSent: number;
}

export async function runReorderReminderSweep(
  db: PrismaClient,
  email: NotificationEmailPort,
  now: Date,
): Promise<ReorderSweepResult> {
  const engine = new NotificationEngine(db, email, NOTIFICATIONS_SYSTEM_ACTOR);
  const rules = await db.reorderRule.findMany({
    where: { isActive: true, nextOrderAt: { lte: now } },
    orderBy: [{ nextOrderAt: "asc" }, { id: "asc" }],
    include: { listing: { select: { id: true, title: true } } },
  });

  let notificationsSent = 0;
  let emailsSent = 0;
  let rulesReminded = 0;
  for (const rule of rules) {
    const cadenceDays = rule.cadenceDays ?? 0;
    if (cadenceDays < 1) {
      // createRule refuses non-positive cadences; a straggler row is left
      // due rather than silently rescheduled into the far future.
      continue;
    }
    const nextOrderAt = addDays(now, cadenceDays);
    const memberIds = await engine.orgMemberUserIds(rule.orgId);
    const content = reorderReminderContent(rule.listing.title, cadenceDays, rule.nextOrderAt ?? now);

    const result = await db.$transaction(async (tx) => {
      if (memberIds.length > 0) {
        const sent = await engine.notify({
          orgId: rule.orgId,
          userIds: memberIds,
          kind: "REORDER_REMINDER",
          title: content.title,
          body: content.body,
          linkUrl: content.linkUrl,
          entityType: "ReorderRule",
          entityId: rule.id,
          now,
        });
        // ReorderRepository's user-path audit writes "reorder.remind"; the
        // system sweep writes the same action so either path shows in the
        // audit trail.
        await tx.auditLog.create({
          data: {
            orgId: rule.orgId,
            actorUserId: null,
            actorType: "system",
            action: REORDER_AUDIT.remind,
            entityType: "ReorderRule",
            entityId: rule.id,
            after: { nextOrderAt } as Prisma.InputJsonValue,
          },
        });
        await tx.reorderRule.update({
          where: { id: rule.id },
          data: { nextOrderAt },
        });
        return { notifications: sent.notificationIds.length, emails: sent.emails.length };
      }
      // No members to notify — still honor the cadence so the rule does not
      // refire on every sweep.
      await tx.reorderRule.update({
        where: { id: rule.id },
        data: { nextOrderAt },
      });
      return { notifications: 0, emails: 0 };
    });

    rulesReminded += 1;
    notificationsSent += result.notifications;
    emailsSent += result.emails;
  }
  return { rulesReminded, notificationsSent, emailsSent };
}
