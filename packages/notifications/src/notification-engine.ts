/**
 * Notification engine (spec: staff admin + reminders). One entry point,
 * `notify`, fans a single event out to recipients as in-app Notification
 * rows and (optionally) mock emails — every leg written inside one
 * transaction and recorded in the append-only AuditLog, so every send is
 * auditable. The engine never reads the wall clock: callers pass `now`.
 */
import { Prisma, type PrismaClient, type NotificationKind } from "@packsource/db";
import { RecordNotFoundError } from "@packsource/core";
import type { NotificationEmailPort } from "./email";

/** Audit action written once per send (AuditLog is append-only). */
export const NOTIFICATION_AUDIT = {
  sent: "notification.sent",
} as const;

/** Who caused the send — a signed-in actor or a background job. */
export interface NotificationActor {
  actorType: "user" | "system";
  /** Auth.js user id; null for system sends. */
  userId?: string | null;
}

export interface NotifyInput {
  /** The org whose data the notification is about (audit + row org). */
  orgId: string;
  /** Recipients, deduplicated and order-preserving. */
  userIds: string[];
  kind: NotificationKind;
  title: string;
  body?: string;
  /** In-app deep link, e.g. "/orders/<id>". */
  linkUrl?: string;
  entityType?: string;
  entityId?: string;
  /**
   * Email leg. Default on — pass { enabled: false } for in-app-only sends.
   * The mock adapter records every send; the real adapter (Resend) replaces
   * it behind the same port.
   */
  email?: { enabled?: boolean };
  /** Deterministic clock. */
  now: Date;
}

export interface NotifyResult {
  /** Created in-app notification rows, recipient order preserved. */
  notificationIds: string[];
  /** Email adapter result ids per recipient (email leg only). */
  emails: { userId: string; emailId: string }[];
}

/** Recipient has no User row (deleted mid-flight) — fail loudly, not silently. */
export class NotificationRecipientError extends Error {
  constructor(userId: string) {
    super(`notification recipient ${userId} does not exist`);
    this.name = "NotificationRecipientError";
  }
}

export class NotificationEngine {
  readonly #db: PrismaClient;
  readonly #email: NotificationEmailPort;
  readonly #actor: NotificationActor;

  constructor(db: PrismaClient, email: NotificationEmailPort, actor: NotificationActor) {
    this.#db = db;
    this.#email = email;
    this.#actor = actor;
  }

  /**
   * Send one event to its recipients: in-app rows + mock emails + audit
   * rows, all in one transaction. Duplicate userIds collapse (a member with
   * two memberships in the org must not get two rows).
   */
  async notify(input: NotifyInput): Promise<NotifyResult> {
    const userIds = [...new Set(input.userIds)];
    if (userIds.length === 0) {
      return { notificationIds: [], emails: [] };
    }
    return this.#db.$transaction(async (tx) => {
      const users = await tx.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
      });
      const emailByUserId = new Map(users.map((user) => [user.id, user.email]));
      for (const userId of userIds) {
        if (!emailByUserId.has(userId)) {
          throw new NotificationRecipientError(userId);
        }
      }

      const notificationIds: string[] = [];
      const emails: { userId: string; emailId: string }[] = [];
      const emailEnabled = input.email?.enabled !== false;
      for (const userId of userIds) {
        const notification = await tx.notification.create({
          data: {
            userId,
            orgId: input.orgId,
            kind: input.kind,
            title: input.title,
            body: input.body,
            linkUrl: input.linkUrl,
            entityType: input.entityType,
            entityId: input.entityId,
          },
        });
        notificationIds.push(notification.id);

        let emailId: string | undefined;
        if (emailEnabled) {
          const to = emailByUserId.get(userId);
          if (!to) {
            throw new NotificationRecipientError(userId);
          }
          const sent = await this.#email.send(
            { to, subject: input.title, text: input.body ?? input.title },
            input.now,
          );
          emailId = sent.id;
          emails.push({ userId, emailId });
        }

        // One audit row per send — the durable delivery record (the mock
        // adapter's outbox is in-memory by design).
        await tx.auditLog.create({
          data: {
            orgId: input.orgId,
            actorUserId: this.#actor.userId ?? null,
            actorType: this.#actor.actorType,
            action: NOTIFICATION_AUDIT.sent,
            entityType: "Notification",
            entityId: notification.id,
            after: {
              kind: input.kind,
              userId,
              channels: emailEnabled ? ["in_app", "email"] : ["in_app"],
              ...(emailId ? { emailId, emailTo: emailByUserId.get(userId) } : {}),
            } as Prisma.InputJsonValue,
          },
        });
      }
      return { notificationIds, emails };
    });
  }

  /** Convenience: every current member of an org (optionally filtered by roles). */
  async orgMemberUserIds(orgId: string, roles?: readonly string[]): Promise<string[]> {
    const members = await this.#db.orgMembership.findMany({
      where: { orgId, ...(roles ? { role: { in: roles as never[] } } : {}) },
      orderBy: { userId: "asc" },
      select: { userId: true },
    });
    return members.map((member) => member.userId);
  }

  /** Load a notification for an audit trail lookup (admin tooling). */
  async getNotification(notificationId: string) {
    const notification = await this.#db.notification.findUnique({
      where: { id: notificationId },
      include: {
        user: { select: { id: true, email: true } },
        org: { select: { id: true, name: true } },
      },
    });
    if (!notification) {
      throw new RecordNotFoundError("Notification", notificationId);
    }
    return notification;
  }
}
