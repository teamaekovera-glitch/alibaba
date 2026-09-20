/**
 * Escrow math tests: exact integer-cent commission splits, ledger balance
 * integrity, dispute freeze in the release decision, and the 7-day
 * auto-release window (spec acceptance: "exact integer-cent money tests").
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_RELEASE_WINDOW_DAYS,
  EscrowError,
  commissionSplit,
  escrowBalance,
  escrowKeys,
  releaseDecision,
} from "../../src/orders/escrow";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-03-01T00:00:00Z");

describe("commissionSplit", () => {
  it("splits 5% exactly and sums back to gross", () => {
    const { commissionCents, netCents } = commissionSplit(123_456, 500);
    expect(commissionCents).toBe(6_173); // round(123456 * 0.05)
    expect(netCents).toBe(117_283);
    expect(commissionCents + netCents).toBe(123_456);
  });

  it("rounds half up at the cent boundary", () => {
    expect(commissionSplit(101, 50).commissionCents).toBe(1);
    expect(commissionSplit(100, 50).commissionCents).toBe(1);
  });

  it("handles zero gross and zero commission", () => {
    expect(commissionSplit(0, 500)).toEqual({ commissionCents: 0, netCents: 0 });
    expect(commissionSplit(50_000, 0)).toEqual({ commissionCents: 0, netCents: 50_000 });
  });

  it("rejects negative or fractional money", () => {
    expect(() => commissionSplit(-1, 500)).toThrow(EscrowError);
    expect(() => commissionSplit(10.5, 500)).toThrow(EscrowError);
    expect(() => commissionSplit(100, -1)).toThrow(EscrowError);
  });
});

describe("escrowBalance", () => {
  it("reduces hold -> release + commission to zero", () => {
    const balance = escrowBalance([
      { kind: "HOLD", amountCents: 100_000 },
      { kind: "RELEASE", amountCents: 95_000 },
      { kind: "COMMISSION", amountCents: 5_000 },
    ]);
    expect(balance).toBe(0);
  });

  it("tracks partial refunds against the held balance", () => {
    const balance = escrowBalance([
      { kind: "HOLD", amountCents: 70_000 },
      { kind: "PARTIAL_REFUND", amountCents: 20_000 },
      { kind: "RELEASE", amountCents: 47_500 },
      { kind: "COMMISSION", amountCents: 2_500 },
    ]);
    expect(balance).toBe(0);
  });

  it("throws when entries would overdraw the ledger", () => {
    expect(() =>
      escrowBalance([
        { kind: "HOLD", amountCents: 100 },
        { kind: "REFUND", amountCents: 101 },
      ]),
    ).toThrow(EscrowError);
  });

  it("throws on negative or fractional amounts", () => {
    expect(() => escrowBalance([{ kind: "HOLD", amountCents: -5 }])).toThrow(EscrowError);
    expect(() => escrowBalance([{ kind: "HOLD", amountCents: 1.5 }])).toThrow(EscrowError);
  });
});

describe("releaseDecision", () => {
  const base = { deliveredAt: null, shippedAt: null };

  it("releases immediately on delivery confirmation", () => {
    expect(releaseDecision({ ...base, status: "DELIVERED" }, null, T0)).toEqual({
      action: "RELEASE",
      via: "delivery",
    });
  });

  it("releases automatically 7 days after shipment", () => {
    const shipped = { ...base, status: "SHIPPED" as const, shippedAt: T0 };
    expect(releaseDecision(shipped, null, new Date(T0.getTime() + 7 * DAY - 1))).toEqual({
      action: "NOT_ELIGIBLE",
    });
    expect(releaseDecision(shipped, null, new Date(T0.getTime() + 7 * DAY))).toEqual({
      action: "RELEASE",
      via: "auto",
    });
  });

  it("freezes the transfer while a dispute is open", () => {
    expect(releaseDecision({ ...base, status: "DELIVERED" }, "dsp_1", T0)).toEqual({
      action: "HOLD_DISPUTE",
    });
    const shipped = { ...base, status: "SHIPPED" as const, shippedAt: T0 };
    expect(releaseDecision(shipped, "dsp_1", new Date(T0.getTime() + 30 * DAY))).toEqual({
      action: "HOLD_DISPUTE",
    });
  });

  it("is not eligible before shipping ends", () => {
    for (const status of ["DRAFT", "DEPOSIT_DUE", "DEPOSIT_PAID", "IN_PRODUCTION", "READY_TO_SHIP"] as const) {
      expect(releaseDecision({ ...base, status }, null, T0)).toEqual({ action: "NOT_ELIGIBLE" });
    }
  });

  it("exposes the 7-day window as a named constant", () => {
    expect(AUTO_RELEASE_WINDOW_DAYS).toBe(7);
  });
});

describe("escrowKeys", () => {
  it("derives stable keys per logical movement", () => {
    expect(escrowKeys.hold("pay_1")).toBe("hold:pay_1");
    expect(escrowKeys.release("ord_1")).toBe("release:ord_1");
    expect(escrowKeys.commission("ord_1")).toBe("commission:ord_1");
    expect(escrowKeys.refund("ord_1", "pay_1")).toBe("refund:ord_1:pay_1");
    expect(escrowKeys.partialRefund("ord_1", "dsp_1")).toBe("refund:ord_1:partial:dsp_1");
    expect(escrowKeys.payout("ord_1", "sub_1")).toBe("payout:ord_1:sub_1");
    expect(escrowKeys.payment("ord_1", "DEPOSIT")).toBe("pay:ord_1:DEPOSIT");
  });

  it("keys differ per payment so two holds never collide", () => {
    expect(escrowKeys.hold("pay_1")).not.toBe(escrowKeys.hold("pay_2"));
  });
});
