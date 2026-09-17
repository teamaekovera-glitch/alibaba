import { Counter } from "./counter";
import type { EnqueueResult, QueueAdapter, QueueEventEnvelope } from "../types";

/** Deterministic Inngest stand-in: records every enqueued event. */
export class MockQueueAdapter implements QueueAdapter {
  readonly #events: QueueEventEnvelope[] = [];
  readonly #counter = new Counter();

  async send<TData>(event: QueueEventEnvelope<TData>): Promise<EnqueueResult> {
    const result: EnqueueResult = { id: this.#counter.nextId("evt_mock") };
    this.#events.push({ name: event.name, data: event.data });
    return result;
  }

  /** Test helper: enqueued events, in order. */
  events(): readonly QueueEventEnvelope[] {
    return this.#events;
  }
}
