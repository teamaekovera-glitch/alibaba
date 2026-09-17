import { describe, expect, it } from "vitest";
import { createAdapters, MockEmbeddingAdapter, MockLlmAdapter, MockMailAdapter, MockModeError, MockPaymentsAdapter, MockQueueAdapter, MockRealtimeAdapter, MockSearchAdapter, MockStorageAdapter, MockTrackingAdapter, MockVisionAdapter } from "../../src/index";
import type { Adapters } from "../../src/index";

/**
 * Contract: every mock implements its adapter interface. This assignment is
 * checked by tsc — if a mock drifts from its interface, typecheck fails.
 */
const contractBundle: Adapters = {
  llm: new MockLlmAdapter(),
  embedding: new MockEmbeddingAdapter(),
  vision: new MockVisionAdapter(),
  search: new MockSearchAdapter(),
  payments: new MockPaymentsAdapter(),
  mail: new MockMailAdapter(),
  realtime: new MockRealtimeAdapter(),
  storage: new MockStorageAdapter(),
  tracking: new MockTrackingAdapter(),
  queue: new MockQueueAdapter(),
};

describe("adapter factory", () => {
  it("returns mocks by default (MOCK unset)", () => {
    const adapters = createAdapters({});
    expect(adapters.llm).toBeInstanceOf(MockLlmAdapter);
    expect(adapters.embedding).toBeInstanceOf(MockEmbeddingAdapter);
    expect(adapters.vision).toBeInstanceOf(MockVisionAdapter);
    expect(adapters.search).toBeInstanceOf(MockSearchAdapter);
    expect(adapters.payments).toBeInstanceOf(MockPaymentsAdapter);
    expect(adapters.mail).toBeInstanceOf(MockMailAdapter);
    expect(adapters.realtime).toBeInstanceOf(MockRealtimeAdapter);
    expect(adapters.storage).toBeInstanceOf(MockStorageAdapter);
    expect(adapters.tracking).toBeInstanceOf(MockTrackingAdapter);
    expect(adapters.queue).toBeInstanceOf(MockQueueAdapter);
  });

  it("treats MOCK=true explicitly as mocks", () => {
    const adapters = createAdapters({ MOCK: "true" });
    expect(adapters.llm).toBeInstanceOf(MockLlmAdapter);
  });

  it("refuses MOCK=false while real providers are not wired", () => {
    expect(() => createAdapters({ MOCK: "false" })).toThrowError(MockModeError);
  });
});

describe("mock contracts — determinism and behavior", () => {
  it("llm mock is deterministic", async () => {
    const request = {
      system: "You draft RFQs.",
      messages: [{ role: "user" as const, content: "Draft an RFQ for 25k hot-fill PET bottles" }],
    };
    const first = await contractBundle.llm.complete(request);
    const second = await contractBundle.llm.complete(request);
    expect(second).toEqual(first);
    expect(first.text).toContain("Draft an RFQ");
  });

  it("embedding mock is deterministic and dimension-stable", async () => {
    const a = await contractBundle.embedding.embed("clear 12oz hot-fill bottle");
    const b = await contractBundle.embedding.embed("clear 12oz hot-fill bottle");
    const c = await contractBundle.embedding.embed("stand-up pouch");
    expect(b).toEqual(a);
    expect(c.vector).not.toEqual(a.vector);
    expect(a.dimensions).toBe(a.vector.length);
    const batch = await contractBundle.embedding.embedBatch(["x", "y"]);
    expect(batch).toHaveLength(2);
  });

  it("vision mock is deterministic and content-sensitive", async () => {
    const image = { base64: "aGVsbG8=", mimeType: "image/png" };
    const a = await contractBundle.vision.classify(image);
    const b = await contractBundle.vision.classify(image);
    expect(b).toEqual(a);
    expect(a.labels.length).toBeGreaterThan(0);
    const other = await contractBundle.vision.classify({ ...image, base64: "Zm9v" });
    expect(other.inputHash).not.toEqual(a.inputHash);
  });

  it("search mock round-trips index and query with facet filters", async () => {
    const search = contractBundle.search;
    await search.index("listings", [
      { id: "l1", title: "Clear PET hot-fill bottle 12oz", attributes: { material: "PET" } },
      { id: "l2", title: "Stand-up pouch with spout", attributes: { material: "PE" } },
    ]);
    const hits = await search.query("listings", { q: "hot-fill bottle" });
    expect(hits.map((h) => h.id)).toEqual(["l1"]);
    const filtered = await search.query("listings", { q: "pouch", filters: { material: "PE" } });
    expect(filtered.map((h) => h.id)).toEqual(["l2"]);
    const none = await search.query("listings", { q: "pouch", filters: { material: "PET" } });
    expect(none).toEqual([]);
  });

  it("payments mock enforces hold/transfer/refund ledger semantics", async () => {
    const payments = contractBundle.payments;
    const charge = await payments.captureCharge({ amountCents: 100_00, currency: "usd" });
    await payments.transferToConnectedAccount({
      chargeId: charge.id,
      connectedAccountId: "acct_supplier",
      amountCents: 40_00,
    });
    await payments.refundCharge(charge.id, 60_00);
    const after = await payments.getCharge(charge.id);
    expect(after?.status).toBe("refunded");
    await expect(payments.refundCharge(charge.id, 1)).rejects.toThrowError(
      /insufficient_held_funds/,
    );
  });

  it("payments mock refuses transfers beyond the held balance", async () => {
    const payments = contractBundle.payments;
    const charge = await payments.captureCharge({ amountCents: 50_00, currency: "usd" });
    await expect(
      payments.transferToConnectedAccount({
        chargeId: charge.id,
        connectedAccountId: "acct_supplier",
        amountCents: 50_01,
      }),
    ).rejects.toThrowError(/insufficient_held_funds/);
  });

  it("mail, realtime, and queue mocks record with deterministic ids", async () => {
    const sent = await contractBundle.mail.send({ to: "buyer@example.com", subject: "Quote ready", html: "<p>q</p>" });
    expect(sent.accepted).toBe(true);
    expect(sent.id).toBe("email_mock_000001");
    await expect(
      contractBundle.realtime.trigger({ channel: "rfq.1", event: "quote.created", payload: { id: "q1" } }),
    ).resolves.toEqual({ ok: true });
    await expect(contractBundle.queue.send({ name: "escrow/release", data: { orderId: "o1" } })).resolves.toEqual({
      id: "evt_mock_000001",
    });
  });

  it("storage mock round-trips bytes with deterministic signed urls", async () => {
    await contractBundle.storage.put("dielines/a.pdf", "PDFBYTES", "application/pdf");
    const stored = await contractBundle.storage.get("dielines/a.pdf");
    expect(new TextDecoder().decode(stored?.body ?? new Uint8Array())).toBe("PDFBYTES");
    await expect(contractBundle.storage.signedUrl("dielines/a.pdf", 900)).resolves.toBe(
      "https://mock-r2.internal/dielines/a.pdf?expires=900",
    );
    await expect(contractBundle.storage.get("missing")).resolves.toBeUndefined();
  });

  it("tracking mock reports a fixed timeline for created shipments", async () => {
    const shipment = await contractBundle.tracking.createShipment({ carrier: "mock_express" });
    const status = await contractBundle.tracking.track(shipment.trackingCode);
    expect(status.status).toBe("in_transit");
    expect(status.events.length).toBeGreaterThan(0);
    const again = await contractBundle.tracking.track(shipment.trackingCode);
    expect(again).toEqual(status);
    const unknown = await contractBundle.tracking.track("trk_mock_999999");
    expect(unknown.status).toBe("unknown");
    expect(unknown.events).toEqual([]);
  });
});
