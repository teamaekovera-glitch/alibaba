/**
 * Notification email seam (spec: "every external service sits behind a typed
 * adapter with a MOCK=true implementation"). Resend replaces the mock at
 * deploy time behind the same port; nothing else in the app may construct a
 * mail transport. The mock is deterministic: ids are sequential, sends are
 * recorded in an in-memory outbox, and the clock is always passed in — zero
 * API keys, reproducible tests.
 */

/** One notification email addressed to a single recipient. */
export interface NotificationEmail {
  to: string;
  subject: string;
  text: string;
}

export interface NotificationEmailResult {
  id: string;
}

/** The email leg of a notification send. */
export interface NotificationEmailPort {
  send(email: NotificationEmail, at: Date): Promise<NotificationEmailResult>;
}

/** A recorded mock send, in send order. */
export interface SentNotificationEmail extends NotificationEmail {
  id: string;
  sentAt: Date;
}

/** Deterministic Resend stand-in: records every send in an outbox. */
export class MockNotificationEmailAdapter implements NotificationEmailPort {
  readonly #outbox: SentNotificationEmail[] = [];
  readonly #sequence: { value: number };

  constructor(sequence: { value: number } = { value: 0 }) {
    this.#sequence = sequence;
  }

  async send(email: NotificationEmail, at: Date): Promise<NotificationEmailResult> {
    this.#sequence.value += 1;
    const id = `notif_email_${String(this.#sequence.value).padStart(6, "0")}`;
    this.#outbox.push({ ...email, id, sentAt: at });
    return { id };
  }

  /** Test/dev helper: sent mail, in send order. */
  outbox(): readonly SentNotificationEmail[] {
    return [...this.#outbox];
  }

  /** Test helper: reset the outbox and id sequence (deterministic reruns). */
  reset(): void {
    this.#outbox.length = 0;
    this.#sequence.value = 0;
  }
}
