/**
 * Payment-schedule planning tests (spec acceptance: "Each schedule type
 * produces the specified milestone sequence" + "exact integer-cent money
 * tests").
 */
import { describe, expect, it } from "vitest";
import {
  DEPOSIT_BPS,
  InvalidScheduleError,
  assertNet30Approved,
  balancePlan,
  net30DueAt,
  splitDeposit,
  upfrontPlan,
} from "../../src/orders/payment-schedule";

const T0 = new Date("2026-05-01T00:00:00Z");

describe("splitDeposit — exact integer cents", () => {
  it("splits 30/70 with zero remainder on round totals", () => {
    expect(splitDeposit(100_000)).toEqual({ depositCents: 30_000, balanceCents: 70_000 });
  });

  it("sums to the total on awkward totals (no lost cents)", () => {
    for (const total of [1, 2, 3, 7, 13, 101, 999, 12_345, 1_234_567]) {
      const { depositCents, balanceCents } = splitDeposit(total);
      expect(depositCents + balanceCents).toBe(total);
    }
  });

  it("floors the deposit (buyer never overpays the deposit leg)", () => {
    expect(splitDeposit(101)).toEqual({ depositCents: 30, balanceCents: 71 });
    expect(splitDeposit(3)).toEqual({ depositCents: 0, balanceCents: 3 });
  });

  it("rejects negative or fractional totals", () => {
    expect(() => splitDeposit(-5)).toThrow(InvalidScheduleError);
    expect(() => splitDeposit(10.5)).toThrow(InvalidScheduleError);
  });
});

describe("upfrontPlan — placement milestones", () => {
  it("FULL_PREPAY charges 100% as a FULL payment", () => {
    expect(upfrontPlan("FULL_PREPAY", 250_000, T0)).toEqual([
      { kind: "FULL", amountCents: 250_000, dueAt: T0 },
    ]);
  });

  it("DEPOSIT_30_70 charges the 30% deposit only", () => {
    expect(upfrontPlan("DEPOSIT_30_70", 100_000, T0)).toEqual([
      { kind: "DEPOSIT", amountCents: 30_000, dueAt: T0 },
    ]);
  });

  it("DEPOSIT_30_70 falls back to a full charge when the deposit floors to zero", () => {
    expect(upfrontPlan("DEPOSIT_30_70", 3, T0)).toEqual([{ kind: "FULL", amountCents: 3, dueAt: T0 }]);
  });

  it("NET_30 collects nothing up front", () => {
    expect(upfrontPlan("NET_30", 500_000, T0)).toEqual([]);
  });

  it("keeps DEPOSIT_BPS aligned with the spec's 30%", () => {
    expect(DEPOSIT_BPS).toBe(3_000);
  });
});

describe("balancePlan — balance milestones", () => {
  it("DEPOSIT_30_70 balances to the remainder, due immediately at issue", () => {
    const [item] = balancePlan("DEPOSIT_30_70", 100_000, 30_000, T0);
    expect(item).toEqual({ kind: "BALANCE", amountCents: 70_000, dueAt: T0 });
  });

  it("NET_30 balances to the full total, due 30 days out", () => {
    const [item] = balancePlan("NET_30", 500_000, 0, T0);
    expect(item?.amountCents).toBe(500_000);
    expect(item?.dueAt).toEqual(net30DueAt(T0));
  });

  it("emits nothing when the deposit covered everything", () => {
    expect(balancePlan("DEPOSIT_30_70", 100_000, 100_000, T0)).toEqual([]);
    expect(balancePlan("FULL_PREPAY", 100_000, 100_000, T0)).toEqual([]);
  });

  it("rejects overpayment", () => {
    expect(() => balancePlan("NET_30", 100, 200, T0)).toThrow(InvalidScheduleError);
  });
});

describe("net30DueAt — deterministic calendar math", () => {
  it("adds 30 calendar days in UTC", () => {
    expect(net30DueAt(new Date("2026-01-15T00:00:00Z"))).toEqual(new Date("2026-02-14T00:00:00Z"));
  });

  it("crosses month and year boundaries cleanly", () => {
    expect(net30DueAt(new Date("2026-01-31T00:00:00Z"))).toEqual(new Date("2026-03-02T00:00:00Z"));
    expect(net30DueAt(new Date("2026-12-01T00:00:00Z"))).toEqual(new Date("2026-12-31T00:00:00Z"));
  });
});

describe("assertNet30Approved — staff gate", () => {
  it("passes when the approval is recorded", () => {
    expect(() => assertNet30Approved(T0)).not.toThrow();
  });

  it("throws when approval is missing", () => {
    expect(() => assertNet30Approved(null)).toThrow(InvalidScheduleError);
    expect(() => assertNet30Approved(undefined)).toThrow(/staff approval/);
  });
});
