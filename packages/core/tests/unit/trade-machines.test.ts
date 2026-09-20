import { describe, expect, it } from "vitest";
import type { QuoteStatus, RfqMode, RfqStatus } from "@packsource/db";
import {
  assertCloseTimeAllows,
  isQuoteValidAt,
  isRfqPastDue,
  rfqTransition,
  IllegalRfqTransitionError,
} from "../../src/trade/rfq-machine";
import {
  quoteTransition,
  IllegalQuoteTransitionError,
  TERMINAL_QUOTE_STATUSES,
} from "../../src/trade/quote-machine";
import {
  canShareContacts,
  hasContactInfo,
  redactContactInfo,
  REDACTED_CONTACT_PLACEHOLDER,
} from "../../src/trade/redaction";
import {
  computeLandedCost,
  landedCostComponentsFromQuote,
  LandedCostError,
  tierPrice,
} from "../../src/trade/landed-cost";

/**
 * Exhaustive pure state-machine coverage: every legal transition asserted,
 * every illegal (status, event) pair asserted to throw, plus the time-based
 * guards. The schema enums are the source of truth — iterate them so a new
 * enum member without machine coverage fails here.
 */

const T0 = new Date("2026-09-20T12:00:00Z");

const ALL_RFQ_STATUSES: RfqStatus[] = ["DRAFT", "OPEN", "AWARDED", "CLOSED", "CANCELLED"];
const ALL_RFQ_EVENTS = ["SEND", "CLOSE", "AWARD", "CANCEL"] as const;
const ALL_QUOTE_STATUSES: QuoteStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
  "WITHDRAWN",
  "SUPERSEDED",
];
const ALL_QUOTE_EVENTS = ["SUBMIT", "ACCEPT", "DECLINE", "EXPIRE", "WITHDRAW", "SUPERSEDE"] as const;

describe("rfq state machine", () => {
  it("applies every legal transition", () => {
    expect(rfqTransition("DRAFT", { type: "SEND", at: T0 })).toBe("OPEN");
    expect(rfqTransition("DRAFT", { type: "CANCEL", at: T0 })).toBe("CANCELLED");
    expect(rfqTransition("OPEN", { type: "CLOSE", at: T0 })).toBe("CLOSED");
    expect(rfqTransition("OPEN", { type: "AWARD", at: T0 })).toBe("AWARDED");
    expect(rfqTransition("OPEN", { type: "CANCEL", at: T0 })).toBe("CANCELLED");
    expect(rfqTransition("CLOSED", { type: "AWARD", at: T0 })).toBe("AWARDED");
  });

  it("throws for every illegal (status, event) pair", () => {
    for (const status of ALL_RFQ_STATUSES) {
      for (const type of ALL_RFQ_EVENTS) {
        const legal =
          (status === "DRAFT" && (type === "SEND" || type === "CANCEL")) ||
          (status === "OPEN" && (type === "CLOSE" || type === "AWARD" || type === "CANCEL")) ||
          (status === "CLOSED" && type === "AWARD");
        if (legal) {
          continue;
        }
        expect(() => rfqTransition(status, { type, at: T0 }), `${type} from ${status}`).toThrowError(
          IllegalRfqTransitionError,
        );
      }
    }
  });

  it("blocks award, close, and cancel on an auction before its close time", () => {
    const closesAt = new Date("2026-09-25T00:00:00Z");
    const guards = { mode: "AUCTION" as RfqMode, closesAt };
    for (const event of ["AWARD", "CLOSE", "CANCEL"] as const) {
      expect(() => assertCloseTimeAllows(guards, event, new Date("2026-09-24T23:59:59Z"))).toThrowError(
        IllegalRfqTransitionError,
      );
    }
    // At the close time and after, all three are allowed.
    for (const event of ["AWARD", "CLOSE", "CANCEL"] as const) {
      expect(() => assertCloseTimeAllows(guards, event, closesAt)).not.toThrow();
      expect(() => assertCloseTimeAllows(guards, event, new Date("2026-09-26T00:00:00Z"))).not.toThrow();
    }
  });

  it("never applies the close-time guard to non-auction RFQs", () => {
    const guards = { mode: "BROADCAST" as RfqMode, closesAt: new Date("2099-01-01T00:00:00Z") };
    expect(() => assertCloseTimeAllows(guards, "AWARD", T0)).not.toThrow();
    expect(() => assertCloseTimeAllows(guards, "CANCEL", T0)).not.toThrow();
  });

  it("flags past-due auctions only", () => {
    const closesAt = new Date("2026-09-19T00:00:00Z");
    expect(isRfqPastDue({ mode: "AUCTION", closesAt }, T0)).toBe(true);
    expect(isRfqPastDue({ mode: "AUCTION", closesAt: null }, T0)).toBe(false);
    expect(isRfqPastDue({ mode: "BROADCAST", closesAt }, T0)).toBe(false);
  });
});

describe("quote state machine", () => {
  it("applies every legal transition", () => {
    expect(quoteTransition("DRAFT", { type: "SUBMIT", at: T0 })).toBe("SUBMITTED");
    expect(quoteTransition("DRAFT", { type: "WITHDRAW", at: T0 })).toBe("WITHDRAWN");
    expect(quoteTransition("SUBMITTED", { type: "ACCEPT", at: T0 })).toBe("ACCEPTED");
    expect(quoteTransition("SUBMITTED", { type: "DECLINE", at: T0 })).toBe("DECLINED");
    expect(quoteTransition("SUBMITTED", { type: "EXPIRE", at: T0 })).toBe("EXPIRED");
    expect(quoteTransition("SUBMITTED", { type: "WITHDRAW", at: T0 })).toBe("WITHDRAWN");
    expect(quoteTransition("SUBMITTED", { type: "SUPERSEDE", at: T0 })).toBe("SUPERSEDED");
  });

  it("throws for every illegal (status, event) pair", () => {
    for (const status of ALL_QUOTE_STATUSES) {
      for (const type of ALL_QUOTE_EVENTS) {
        const legal =
          (status === "DRAFT" && (type === "SUBMIT" || type === "WITHDRAW")) ||
          (status === "SUBMITTED" && type !== "SUBMIT");
        if (legal) {
          continue;
        }
        expect(() => quoteTransition(status, { type, at: T0 }), `${type} from ${status}`).toThrowError(
          IllegalQuoteTransitionError,
        );
      }
    }
  });

  it("treats every non-(draft|submitted) status as terminal", () => {
    for (const status of ALL_QUOTE_STATUSES) {
      if (status === "DRAFT" || status === "SUBMITTED") {
        continue;
      }
      expect(TERMINAL_QUOTE_STATUSES).toContain(status);
    }
  });

  it("enforces the validity window at both ends", () => {
    const validFrom = new Date("2026-09-01T00:00:00Z");
    const validUntil = new Date("2026-09-30T00:00:00Z");
    expect(isQuoteValidAt({ validFrom, validUntil }, new Date("2026-09-15T00:00:00Z"))).toBe(true);
    expect(isQuoteValidAt({ validFrom, validUntil }, validFrom)).toBe(true); // inclusive
    expect(isQuoteValidAt({ validFrom, validUntil }, validUntil)).toBe(true); // inclusive
    expect(isQuoteValidAt({ validFrom, validUntil }, new Date("2026-10-01T00:00:00Z"))).toBe(false);
    expect(isQuoteValidAt({ validFrom, validUntil }, new Date("2026-08-31T00:00:00Z"))).toBe(false);
  });
});

describe("contact redaction", () => {
  it("strips emails and phone numbers, preserving the rest of the message", () => {
    const redacted = redactContactInfo(
      "Happy to quote. Email rob@supplier-one.test or call +1 (555) 010-2030 anytime.",
    );
    expect(redacted).not.toContain("rob@supplier-one.test");
    expect(redacted).not.toContain("555");
    expect(redacted).not.toContain("010-2030");
    expect(redacted).toContain("Happy to quote");
    expect(redacted).toContain(REDACTED_CONTACT_PLACEHOLDER);
  });

  it("handles bare-domain and international formats", () => {
    expect(redactContactInfo("reach sales@acme.co.uk today")).not.toContain("sales@acme.co.uk");
    expect(redactContactInfo("call +44 20 7946 0958")).not.toContain("7946 0958");
  });

  it("does not mangle quantities or money", () => {
    const text = "We can do 12,000 units at 42 cents per unit, MOQ 1,000.";
    expect(redactContactInfo(text)).toBe(text);
    expect(hasContactInfo(text)).toBe(false);
  });

  it("detects contact info without rewriting", () => {
    expect(hasContactInfo("ping me at bob@example.com")).toBe(true);
    expect(hasContactInfo("no contact details here")).toBe(false);
  });
});

describe("contact-sharing policy", () => {
  it("unlocks at quote acceptance", () => {
    expect(
      canShareContacts({ quoteAccepted: true, buyerVerificationStatus: "UNVERIFIED", buyerDeliveredOrders: 0 }),
    ).toBe(true);
  });

  it("unlocks for Aekovera-vetted buyers regardless of history", () => {
    expect(
      canShareContacts({ quoteAccepted: false, buyerVerificationStatus: "AEKOVERA_VETTED", buyerDeliveredOrders: 0 }),
    ).toBe(true);
  });

  it("unlocks at three delivered orders for verified buyers", () => {
    expect(canShareContacts({ quoteAccepted: false, buyerVerificationStatus: "VERIFIED", buyerDeliveredOrders: 3 })).toBe(true);
    expect(canShareContacts({ quoteAccepted: false, buyerVerificationStatus: "VERIFIED", buyerDeliveredOrders: 2 })).toBe(false);
  });

  it("stays locked for unverified buyers without delivered orders", () => {
    expect(canShareContacts({ quoteAccepted: false, buyerVerificationStatus: "UNVERIFIED", buyerDeliveredOrders: 0 })).toBe(false);
    expect(canShareContacts({ quoteAccepted: false, buyerVerificationStatus: null, buyerDeliveredOrders: 0 })).toBe(false);
  });
});

describe("quote-to-landed-cost adaptation", () => {
  it("takes fees from the selected ladder step, not the sum across steps", () => {
    // A ladder quote: fees live on the step that applies at the order
    // quantity — the 5,000-unit step's freight is irrelevant at 1,200 units.
    const components = landedCostComponentsFromQuote({
      quantity: 1200,
      unitPriceCents: 42,
      toolingCents: 0,
      plateChargesCents: 0,
      freightCents: 0,
      dutyBps: 400,
      lines: [
        { quantity: 1000, unitPriceCents: 42, toolingCents: 15_000, plateChargesCents: 5_000, freightCents: 15_000 },
        { quantity: 5000, unitPriceCents: 36, toolingCents: 0, plateChargesCents: 0, freightCents: 30_000 },
      ],
    });
    expect(components).toMatchObject({ toolingCents: 15_000, plateChargesCents: 5_000, freightCents: 15_000 });
    const landed = computeLandedCost(components);
    // 42 + round(15000/1200)=13 + round(42*400/10000)=2 + round(20000/1200)=17
    expect(landed.unitLandedCents).toBe(74);
  });

  it("uses the head money when a quote has no lines", () => {
    const components = landedCostComponentsFromQuote({
      quantity: 800,
      unitPriceCents: 55,
      toolingCents: 9_000,
      plateChargesCents: 1_000,
      freightCents: 4_000,
      dutyBps: 0,
      lines: [],
    });
    expect(components).toMatchObject({
      quantity: 800,
      moqTiers: [{ minQty: 800, unitPriceCents: 55 }],
      toolingCents: 9_000,
      plateChargesCents: 1_000,
      freightCents: 4_000,
    });
  });
});

describe("landed cost — exact integer-cent rounding", () => {
  it("resolves the ladder tier for the quantity", () => {
    const tiers = [
      { minQty: 1000, unitPriceCents: 42 },
      { minQty: 5000, unitPriceCents: 36 },
    ];
    expect(tierPrice(tiers, 1200)).toBe(42);
    expect(tierPrice(tiers, 5000)).toBe(36);
    expect(tierPrice(tiers, 99_999)).toBe(36);
    expect(() => tierPrice(tiers, 999)).toThrowError(LandedCostError); // below MOQ
    expect(() => tierPrice([], 100)).toThrowError(LandedCostError);
  });

  it("computes the spec example with every component", () => {
    // 1,200 units @ $0.42 tier; tooling $350 + plates $80; freight $180;
    // duty at 5% (500 bps) — every value in integer cents.
    const landed = computeLandedCost({
      quantity: 1200,
      moqTiers: [
        { minQty: 1000, unitPriceCents: 42 },
        { minQty: 5000, unitPriceCents: 36 },
      ],
      toolingCents: 35_000,
      plateChargesCents: 8_000,
      freightCents: 18_000,
      dutyBps: 500,
    });
    // unit 42 + round(18000/1200)=15 freight + round(42*500/10000)=round(2.1)=2 duty
    //   + round(43000/1200)=round(35.83)=36 amortized = 95
    expect(landed.unitLandedCents).toBe(95);
    // goods 50400 + one-time 43000 + full freight 18000 + duty 2*1200 = 113800
    expect(landed.totalCents).toBe(113_800);
    expect(landed.oneTimeCents).toBe(43_000);
  });

  it("rounds the duty per unit at the half-cent boundary", () => {
    // 50 cents * 100 bps (1%) = 0.5 -> Math.round half-up -> 1.
    expect(
      computeLandedCost({
        quantity: 1,
        moqTiers: [{ minQty: 1, unitPriceCents: 50 }],
        toolingCents: 0,
        plateChargesCents: 0,
        freightCents: 0,
        dutyBps: 100,
      }).unitLandedCents,
    ).toBe(51);
    // 49 cents * 100 bps = 0.49 -> 0.
    expect(
      computeLandedCost({
        quantity: 1,
        moqTiers: [{ minQty: 1, unitPriceCents: 49 }],
        toolingCents: 0,
        plateChargesCents: 0,
        freightCents: 0,
        dutyBps: 100,
      }).unitLandedCents,
    ).toBe(49);
  });

  it("bills one-time costs fully in the total while amortizing per unit", () => {
    // Tiny quantity: amortized one-time rounds to 0 per unit but the total
    // still carries the full $0.01 tooling — the documented asymmetry.
    const landed = computeLandedCost({
      quantity: 3,
      moqTiers: [{ minQty: 1, unitPriceCents: 10 }],
      toolingCents: 1,
      plateChargesCents: 0,
      freightCents: 0,
      dutyBps: 0,
    });
    expect(landed.unitLandedCents).toBe(10); // round(1/3)=0 amortized
    expect(landed.totalCents).toBe(31); // 30 goods + 1 one-time
    expect(landed.oneTimeCents).toBe(1);
  });

  it("keeps zero-cost components at zero", () => {
    const landed = computeLandedCost({
      quantity: 1000,
      moqTiers: [{ minQty: 100, unitPriceCents: 250 }],
      toolingCents: 0,
      plateChargesCents: 0,
      freightCents: 0,
      dutyBps: 0,
    });
    expect(landed.unitLandedCents).toBe(250);
    expect(landed.totalCents).toBe(250_000);
    expect(landed.oneTimeCents).toBe(0);
  });
});
