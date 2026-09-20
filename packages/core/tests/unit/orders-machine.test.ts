/**
 * Exhaustive state-machine tests (spec acceptance: "Exhaustive state-machine
 * unit tests"). Legal paths per schedule, illegal moves, dispute freeze and
 * resolution, and the cancel-before-production rule.
 */
import { describe, expect, it } from "vitest";
import {
  IllegalOrderTransitionError,
  isLegalOrderTransition,
  legalOrderTargets,
  orderTransition,
  type OrderSnapshot,
} from "../../src/orders/order-machine";

const T0 = new Date("2026-01-15T09:00:00Z");

function snap(partial: Partial<OrderSnapshot> & { status: OrderSnapshot["status"] }): OrderSnapshot {
  return { paymentSchedule: "DEPOSIT_30_70", balancePaid: false, openDisputeId: null, ...partial };
}

const PLACE = { type: "PLACE", at: T0 } as const;

describe("order machine — DEPOSIT_30_70 golden path", () => {
  it("walks draft to closed", () => {
    let status = "DRAFT" as OrderSnapshot["status"];
    const events = [
      "PLACE",
      "PAY_DEPOSIT",
      "START_PRODUCTION",
      "COMPLETE_PRODUCTION",
      "ISSUE_BALANCE",
      "SHIP",
      "DELIVER",
      "RELEASE_ESCROW",
      "CLOSE",
    ] as const;
    const expected: string[] = [
      "DEPOSIT_DUE",
      "DEPOSIT_PAID",
      "IN_PRODUCTION",
      "READY_TO_SHIP",
      "BALANCE_DUE",
      "SHIPPED",
      "DELIVERED",
      "ESCROW_RELEASED",
      "CLOSED",
    ];
    for (const [i, type] of events.entries()) {
      // Paying the balance is a repository action (no status move) — model it
      // as settled once the order sits in BALANCE_DUE awaiting shipment.
      const balancePaid = expected.slice(0, i).includes("BALANCE_DUE");
      const transitions = orderTransition(snap({ status, balancePaid }), { type, at: T0 });
      expect(transitions).toHaveLength(1);
      const { to } = transitions[0]!;
      expect(to).toBe(expected[i]);
      status = to;
    }
    expect(status).toBe("CLOSED");
  });

  it("ships only after the balance is paid", () => {
    const atBalanceDue = snap({ status: "BALANCE_DUE" });
    expect(isLegalOrderTransition(atBalanceDue, { type: "SHIP", at: T0 })).toBe(false);
    expect(
      isLegalOrderTransition(snap({ status: "BALANCE_DUE", balancePaid: true }), { type: "SHIP", at: T0 }),
    ).toBe(true);
  });

  it("issues the balance only on the 30/70 schedule", () => {
    expect(isLegalOrderTransition(snap({ status: "READY_TO_SHIP" }), { type: "ISSUE_BALANCE", at: T0 })).toBe(true);
    expect(
      isLegalOrderTransition(snap({ status: "READY_TO_SHIP", paymentSchedule: "FULL_PREPAY" }), {
        type: "ISSUE_BALANCE",
        at: T0,
      }),
    ).toBe(false);
    expect(
      isLegalOrderTransition(snap({ status: "READY_TO_SHIP", paymentSchedule: "NET_30" }), {
        type: "ISSUE_BALANCE",
        at: T0,
      }),
    ).toBe(false);
  });

  it("blocks SHIP from ready-to-ship on 30/70 until the balance leg opened", () => {
    expect(isLegalOrderTransition(snap({ status: "READY_TO_SHIP" }), { type: "SHIP", at: T0 })).toBe(false);
    expect(
      isLegalOrderTransition(snap({ status: "READY_TO_SHIP", paymentSchedule: "FULL_PREPAY" }), {
        type: "SHIP",
        at: T0,
      }),
    ).toBe(true);
  });
});

describe("order machine — FULL_PREPAY skips the balance leg", () => {
  it("goes ready-to-ship -> shipped with no BALANCE_DUE", () => {
    const order = snap({ status: "READY_TO_SHIP", paymentSchedule: "FULL_PREPAY" });
    expect(legalOrderTargets(order)).toContain("SHIPPED");
    expect(legalOrderTargets(order)).not.toContain("BALANCE_DUE");
  });
});

describe("order machine — NET_30 skips deposit legs", () => {
  it("places straight into production and never sits deposit-due", () => {
    const transitions = orderTransition(snap({ status: "DRAFT", paymentSchedule: "NET_30" }), PLACE);
    expect(transitions[0]?.to).toBe("IN_PRODUCTION");
    expect(legalOrderTargets(snap({ status: "DRAFT", paymentSchedule: "NET_30" }))).not.toContain("DEPOSIT_DUE");
  });
});

describe("order machine — illegal transitions", () => {
  it("rejects skipping the deposit", () => {
    expect(() => orderTransition(snap({ status: "DEPOSIT_DUE" }), { type: "START_PRODUCTION", at: T0 })).toThrow(
      IllegalOrderTransitionError,
    );
  });

  it("rejects delivering before shipping", () => {
    expect(() => orderTransition(snap({ status: "READY_TO_SHIP" }), { type: "DELIVER", at: T0 })).toThrow(
      IllegalOrderTransitionError,
    );
  });

  it("rejects closing before escrow release", () => {
    expect(() => orderTransition(snap({ status: "DELIVERED" }), { type: "CLOSE", at: T0 })).toThrow(
      IllegalOrderTransitionError,
    );
  });

  it("rejects any event from terminal states", () => {
    for (const status of ["CLOSED", "CANCELLED"] as const) {
      expect(isLegalOrderTransition(snap({ status }), PLACE)).toBe(false);
      expect(isLegalOrderTransition(snap({ status }), { type: "CANCEL", at: T0 })).toBe(false);
    }
  });

  it("rejects a double release", () => {
    expect(() =>
      orderTransition(snap({ status: "ESCROW_RELEASED" }), { type: "RELEASE_ESCROW", at: T0 }),
    ).toThrow(IllegalOrderTransitionError);
  });

  it("rejects placing twice", () => {
    expect(() => orderTransition(snap({ status: "DEPOSIT_DUE" }), PLACE)).toThrow(IllegalOrderTransitionError);
  });
});

describe("order machine — disputes freeze escrow", () => {
  it("refuses release while a dispute is open", () => {
    const delivered = snap({ status: "DELIVERED", openDisputeId: "dsp_1" });
    expect(isLegalOrderTransition(delivered, { type: "RELEASE_ESCROW", at: T0 })).toBe(false);
    expect(legalOrderTargets(delivered)).not.toContain("ESCROW_RELEASED");
  });

  it("opens disputes only with money held, through delivery", () => {
    expect(isLegalOrderTransition(snap({ status: "DRAFT" }), { type: "OPEN_DISPUTE", at: T0 })).toBe(false);
    expect(isLegalOrderTransition(snap({ status: "DEPOSIT_DUE" }), { type: "OPEN_DISPUTE", at: T0 })).toBe(false);
    expect(isLegalOrderTransition(snap({ status: "DEPOSIT_PAID" }), { type: "OPEN_DISPUTE", at: T0 })).toBe(true);
    expect(isLegalOrderTransition(snap({ status: "SHIPPED" }), { type: "OPEN_DISPUTE", at: T0 })).toBe(true);
    expect(isLegalOrderTransition(snap({ status: "ESCROW_RELEASED" }), { type: "OPEN_DISPUTE", at: T0 })).toBe(false);
  });

  it("resolves a dispute only into legal target states", () => {
    const disputed = snap({ status: "DISPUTED" });
    expect(isLegalOrderTransition(disputed, { type: "RESOLVE_DISPUTE", at: T0, to: "ESCROW_RELEASED" })).toBe(true);
    expect(isLegalOrderTransition(disputed, { type: "RESOLVE_DISPUTE", at: T0, to: "PARTIALLY_REFUNDED" })).toBe(true);
    expect(isLegalOrderTransition(disputed, { type: "RESOLVE_DISPUTE", at: T0, to: "CANCELLED" })).toBe(true);
    expect(isLegalOrderTransition(disputed, { type: "RESOLVE_DISPUTE", at: T0, to: "DELIVERED" })).toBe(true);
    expect(isLegalOrderTransition(disputed, { type: "RESOLVE_DISPUTE", at: T0, to: "IN_PRODUCTION" })).toBe(false);
    expect(isLegalOrderTransition(disputed, { type: "RESOLVE_DISPUTE", at: T0, to: "CLOSED" })).toBe(false);
  });

  it("releases the remainder after a partial refund", () => {
    const partial = snap({ status: "PARTIALLY_REFUNDED", openDisputeId: "dsp_1" });
    expect(isLegalOrderTransition(partial, { type: "RELEASE_ESCROW", at: T0 })).toBe(false);
    expect(isLegalOrderTransition(snap({ status: "PARTIALLY_REFUNDED" }), { type: "RELEASE_ESCROW", at: T0 })).toBe(
      true,
    );
  });
});

describe("order machine — cancel before production", () => {
  it("allows cancel from pre-production states only", () => {
    for (const status of ["DRAFT", "DEPOSIT_DUE", "DEPOSIT_PAID"] as const) {
      expect(isLegalOrderTransition(snap({ status }), { type: "CANCEL", at: T0 })).toBe(true);
    }
    for (const status of ["IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED", "DELIVERED"] as const) {
      expect(isLegalOrderTransition(snap({ status }), { type: "CANCEL", at: T0 })).toBe(false);
    }
  });
});

describe("order machine — transition plan shape", () => {
  it("records from, to, event, and timestamp", () => {
    const [transition] = orderTransition(snap({ status: "DRAFT", paymentSchedule: "FULL_PREPAY" }), PLACE);
    expect(transition).toEqual({ from: "DRAFT", to: "DEPOSIT_DUE", event: "PLACE", at: T0 });
  });
});
