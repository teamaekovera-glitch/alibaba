import type { RealtimeAdapter, RealtimeEvent } from "../types";
/** Deterministic Pusher stand-in: records every triggered event. */
export class MockRealtimeAdapter implements RealtimeAdapter {
  readonly #events: RealtimeEvent[] = [];

  async trigger(event: RealtimeEvent): Promise<{ ok: true }> {
    if (event.channel.length === 0 || event.event.length === 0) {
      throw new Error("channel and event are required");
    }
    this.#events.push({ ...event });
    return { ok: true };
  }

  /** Test helper: triggered events, in order. */
  events(): readonly RealtimeEvent[] {
    return this.#events;
  }
}
