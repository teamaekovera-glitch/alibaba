import { describe, expect, it } from "vitest";
import { MockNotificationEmailAdapter } from "../../src/email";

/**
 * The mock email adapter is the notification system's deterministic email
 * leg: sequential ids, an ordered in-memory outbox, explicit timestamps, and
 * no network. Zero API keys by construction.
 */
describe("MockNotificationEmailAdapter", () => {
  it("records sends in order with sequential ids and the passed-in clock", async () => {
    const adapter = new MockNotificationEmailAdapter();
    const t0 = new Date("2026-04-01T10:00:00.000Z");
    const first = await adapter.send(
      { to: "buyer@example.com", subject: "Hello", text: "body one" },
      t0,
    );
    const second = await adapter.send(
      { to: "supplier@example.com", subject: "World", text: "body two" },
      new Date("2026-04-01T10:05:00.000Z"),
    );

    expect(first.id).toBe("notif_email_000001");
    expect(second.id).toBe("notif_email_000002");
    expect(adapter.outbox().map((mail) => mail.id)).toEqual([first.id, second.id]);
    expect(adapter.outbox()[0]).toMatchObject({ to: "buyer@example.com", sentAt: t0 });
    expect(adapter.outbox()[1]).toMatchObject({ to: "supplier@example.com", subject: "World" });
  });

  it("reset() clears the outbox and restarts the id sequence", async () => {
    const adapter = new MockNotificationEmailAdapter();
    await adapter.send({ to: "a@x.test", subject: "s", text: "t" }, new Date(0));
    adapter.reset();
    expect(adapter.outbox()).toHaveLength(0);
    const next = await adapter.send({ to: "b@x.test", subject: "s", text: "t" }, new Date(0));
    expect(next.id).toBe("notif_email_000001");
  });

  it("shares a sequence across adapters so ids stay unique per process", async () => {
    const sequence = { value: 0 };
    const a = new MockNotificationEmailAdapter(sequence);
    const b = new MockNotificationEmailAdapter(sequence);
    await a.send({ to: "a@x.test", subject: "s", text: "t" }, new Date(0));
    const sent = await b.send({ to: "b@x.test", subject: "s", text: "t" }, new Date(0));
    expect(sent.id).toBe("notif_email_000002");
  });
});
