import { Counter } from "./counter";
import type { MailAdapter, MailRequest, MailResult } from "../types";

/** Deterministic Resend stand-in: records every send in an outbox. */
export class MockMailAdapter implements MailAdapter {
  readonly #outbox: (MailRequest & { id: string })[] = [];
  readonly #counter = new Counter();

  async send(request: MailRequest): Promise<MailResult> {
    const result: MailResult = { id: this.#counter.nextId("email_mock"), accepted: true };
    this.#outbox.push({ ...request, id: result.id });
    return result;
  }

  /** Test helper: sent mail, in send order. */
  outbox(): readonly (MailRequest & { id: string })[] {
    return this.#outbox;
  }
}
