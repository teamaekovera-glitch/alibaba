import { describe, expect, it } from "vitest";
import { WEBHOOK_EVENTS, isWebhookEvent } from "../../src/events";
import {
  SIGNATURE_TOLERANCE_SECONDS,
  signatureHeader,
  verifySignature,
} from "../../src/signing";
import { backoffMs, deterministicDeliveryId } from "../../src/dispatcher";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ hello: "world" });

describe("webhook signing", () => {
  it("produces a deterministic t=, v1= signature header", () => {
    const a = signatureHeader(SECRET, 1_700_000_000, BODY);
    const b = signatureHeader(SECRET, 1_700_000_000, BODY);
    expect(a).toBe(b);
    expect(a).toMatch(/^t=1700000000, v1=[0-9a-f]{64}$/);
  });

  it("verifies a valid signature", () => {
    const header = signatureHeader(SECRET, 1_700_000_000, BODY);
    const result = verifySignature(SECRET, BODY, header, 1_700_000_000);
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signatureHeader(SECRET, 1_700_000_000, BODY);
    const result = verifySignature(SECRET, JSON.stringify({ hello: "evil" }), header, 1_700_000_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects a signature computed with a different secret", () => {
    const header = signatureHeader("whsec_other", 1_700_000_000, BODY);
    const result = verifySignature(SECRET, BODY, header, 1_700_000_000);
    expect(result.ok).toBe(false);
  });

  it("rejects timestamps outside the replay window", () => {
    const header = signatureHeader(SECRET, 1_700_000_000, BODY);
    const stale = verifySignature(
      SECRET,
      BODY,
      header,
      1_700_000_000 + SIGNATURE_TOLERANCE_SECONDS + 1,
    );
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("timestamp outside replay window");
  });

  it("accepts timestamps inside the replay window", () => {
    const header = signatureHeader(SECRET, 1_700_000_000, BODY);
    const result = verifySignature(SECRET, BODY, header, 1_700_000_000 + SIGNATURE_TOLERANCE_SECONDS);
    expect(result.ok).toBe(true);
  });

  it("rejects malformed signature headers", () => {
    expect(verifySignature(SECRET, BODY, "", 1_700_000_000).ok).toBe(false);
    expect(verifySignature(SECRET, BODY, "v1=deadbeef", 1_700_000_000).ok).toBe(false);
    expect(verifySignature(SECRET, BODY, "t=abc, v1=deadbeef", 1_700_000_000).ok).toBe(false);
    expect(verifySignature(SECRET, BODY, "t=1700000000", 1_700_000_000).ok).toBe(false);
  });
});

describe("webhook event catalog", () => {
  it("contains the real audit actions from packages/core", () => {
    // Spot-check the exact action names verified against core source —
    // note shipment.created (not create) and invoice.issued.
    for (const event of [
      "rfq.create",
      "rfq.award",
      "quote.submit",
      "order.place",
      "order.deliver",
      "escrow.release",
      "invoice.issued",
      "payout.settled",
      "shipment.created",
      "shipment.delivered",
      "listing.publish",
      "reorder.remind",
    ]) {
      expect(WEBHOOK_EVENTS).toContain(event);
    }
  });

  it("guards unknown events", () => {
    expect(isWebhookEvent("rfq.create")).toBe(true);
    expect(isWebhookEvent("shipment.create")).toBe(false); // real name is shipment.created
    expect(isWebhookEvent("made.up.event")).toBe(false);
  });
});

describe("deterministic delivery identity", () => {
  it("maps the same event+entity+endpoint to the same delivery id", () => {
    const a = deterministicDeliveryId({
      event: "order.place",
      entityType: "Order",
      entityId: "ord_1",
      url: "https://os.example.com/hooks/packsource",
    });
    const b = deterministicDeliveryId({
      event: "order.place",
      entityType: "Order",
      entityId: "ord_1",
      url: "https://os.example.com/hooks/packsource",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^whd_[0-9a-f]{32}$/);
  });

  it("separates deliveries by endpoint and entity", () => {
    const base = { event: "order.place", entityType: "Order", entityId: "ord_1" };
    const a = deterministicDeliveryId({ ...base, url: "https://os.example.com/a" });
    const b = deterministicDeliveryId({ ...base, url: "https://os.example.com/b" });
    const c = deterministicDeliveryId({ ...base, url: "https://os.example.com/a", entityId: "ord_2" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("retry backoff", () => {
  it("doubles per attempt and caps at 60s", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(4)).toBe(8_000);
    expect(backoffMs(20)).toBe(60_000);
  });
});
