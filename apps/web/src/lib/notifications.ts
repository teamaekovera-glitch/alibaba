/**
 * Web-side notification wiring: the deterministic mock email adapter lives
 * here as a process singleton (same pattern as the mock Stripe adapter in
 * lib/adapters) so every notification send in the app shares one outbox —
 * tests and the demo UI can read `outbox()` to assert on sent mail. Resend
 * replaces this singleton behind the same NotificationEmailPort when MOCK is
 * off; zero API keys anywhere.
 */
import {
  MockNotificationEmailAdapter,
  NotificationEngine,
  NotificationRepository,
  type NotificationEmailPort,
} from "@packsource/notifications";
import type { AuthContext } from "@packsource/core";
import { db } from "@/lib/db";

/** App-wide mock mail transport — one outbox per server process. */
export const notificationEmail: NotificationEmailPort = new MockNotificationEmailAdapter();

/** Engine for the acting user (server actions; audit rows carry their id). */
export function notificationEngine(auth: AuthContext): NotificationEngine {
  return new NotificationEngine(db, notificationEmail, {
    actorType: "user",
    userId: auth.userId,
  });
}

/** The signed-in user's own notification center. */
export function notificationCenter(auth: AuthContext): NotificationRepository {
  return new NotificationRepository(db, auth);
}
