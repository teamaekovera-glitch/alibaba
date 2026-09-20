/**
 * In-app notification center (spec: notifications — list, unread state, mark
 * read). Personal data, not org data: every method is pinned to the acting
 * user's id, so cross-user reads and writes are impossible by construction.
 * No permission gate — any signed-in member may read their own notifications
 * (the gate every admin surface needs is `admin:access`, which does not apply
 * to a person's own inbox).
 */
import type { PrismaClient } from "@packsource/db";
import { RecordNotFoundError, type AuthContext } from "@packsource/core";

export interface NotificationListOptions {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export class NotificationRepository {
  readonly #db: PrismaClient;
  readonly #auth: AuthContext;

  constructor(db: PrismaClient, auth: AuthContext) {
    this.#db = db;
    this.#auth = auth;
  }

  /** The acting user's notifications, newest first (id as deterministic tiebreak). */
  async list(options: NotificationListOptions = {}) {
    return this.#db.notification.findMany({
      where: { userId: this.#auth.userId, ...(options.unreadOnly ? { readAt: null } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: options.limit,
      skip: options.offset,
    });
  }

  async unreadCount(): Promise<number> {
    return this.#db.notification.count({
      where: { userId: this.#auth.userId, readAt: null },
    });
  }

  /** Mark one notification read. Only the recipient may; others 404. */
  async markRead(notificationId: string, at: Date = new Date()) {
    const notification = await this.#db.notification.findFirst({
      where: { id: notificationId, userId: this.#auth.userId },
    });
    if (!notification) {
      throw new RecordNotFoundError("Notification", notificationId);
    }
    if (notification.readAt) {
      return notification; // idempotent replay
    }
    return this.#db.notification.update({
      where: { id: notification.id },
      data: { readAt: at },
    });
  }

  /** Mark every unread notification read; returns how many rows changed. */
  async markAllRead(at: Date = new Date()): Promise<number> {
    const result = await this.#db.notification.updateMany({
      where: { userId: this.#auth.userId, readAt: null },
      data: { readAt: at },
    });
    return result.count;
  }
}
