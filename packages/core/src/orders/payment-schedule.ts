/**
 * Payment schedule planning (spec: "payment schedules FULL_PREPAY |
 * DEPOSIT_30_70 | NET_30; Net-30 only for staff-approved buyers").
 *
 * Every plan is integer cents with exact splits: the deposit is the floor of
 * 30% and the balance is whatever remains, so deposit + balance always
 * equals the order total — no float math, no lost cents.
 */
import type { PaymentKind, PaymentSchedule } from "@packsource/db";

/** 30% deposit on DEPOSIT_30_70 schedules, in basis points. */
export const DEPOSIT_BPS = 3_000;

/** Net-30 invoicing terms (spec: "charges off-session on the due date"). */
export const NET_30_TERM_DAYS = 30;

/** Raised when a schedule request violates the schedule rules. */
export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

/** One planned money event against an order (becomes a Payment row). */
export interface PaymentPlanItem {
  kind: PaymentKind;
  amountCents: number;
  dueAt: Date | null;
}

/**
 * Exact 30/70 split in integer cents: deposit = floor(30%), balance = the
 * remainder so the two always sum to the total.
 */
export function splitDeposit(totalCents: number): { depositCents: number; balanceCents: number } {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new InvalidScheduleError(`total must be a non-negative integer: ${totalCents}`);
  }
  const depositCents = Math.floor((totalCents * DEPOSIT_BPS) / 10_000);
  return { depositCents, balanceCents: totalCents - depositCents };
}

/**
 * The pre-payment plan created at placement (spec: "checkout · payment
 * intent captured"): FULL_PREPAY charges 100% up front, DEPOSIT_30_70
 * charges the 30% deposit; NET_30 collects nothing up front.
 */
export function upfrontPlan(
  schedule: PaymentSchedule,
  totalCents: number,
  at: Date,
): PaymentPlanItem[] {
  switch (schedule) {
    case "FULL_PREPAY":
      return [{ kind: "FULL", amountCents: totalCents, dueAt: at }];
    case "DEPOSIT_30_70": {
      const { depositCents } = splitDeposit(totalCents);
      // A total below 4 cents floors to a zero deposit — charge it in full
      // rather than minting a zero-amount payment.
      if (depositCents <= 0) {
        return [{ kind: "FULL", amountCents: totalCents, dueAt: at }];
      }
      return [{ kind: "DEPOSIT", amountCents: depositCents, dueAt: at }];
    }
    case "NET_30":
      return [];
  }
}

/**
 * The balance plan, issued when the balance leg opens: at
 * ready-to-ship for DEPOSIT_30_70 (spec: "balance invoiced before
 * shipment"), at shipment for NET_30. depositPaidCents is what the buyer
 * already paid (0 for NET_30) — the balance is the remainder.
 */
export function balancePlan(
  schedule: PaymentSchedule,
  totalCents: number,
  depositPaidCents: number,
  issuedAt: Date,
): PaymentPlanItem[] {
  const amountCents = totalCents - depositPaidCents;
  if (amountCents < 0) {
    throw new InvalidScheduleError(`overpaid: deposit ${depositPaidCents} exceeds total ${totalCents}`);
  }
  if (schedule === "DEPOSIT_30_70") {
    return amountCents > 0
      ? [{ kind: "BALANCE", amountCents, dueAt: issuedAt }]
      : [];
  }
  if (schedule === "NET_30") {
    return amountCents > 0
      ? [{ kind: "BALANCE", amountCents, dueAt: net30DueAt(issuedAt) }]
      : [];
  }
  return []; // FULL_PREPAY has no balance leg
}

/** Net-30 due date: shipped + 30 days (deterministic, calendar-day add). */
export function net30DueAt(shippedAt: Date): Date {
  const due = new Date(shippedAt.getTime());
  due.setUTCDate(due.getUTCDate() + NET_30_TERM_DAYS);
  return due;
}

/**
 * NET_30 is only for staff-approved buyers (spec). The approval is recorded
 * on the order (net30ApprovedByUserId/At) by a staff action before placement.
 */
export function assertNet30Approved(approvedAt: Date | null | undefined): void {
  if (!approvedAt) {
    throw new InvalidScheduleError("NET_30 requires prior staff approval of the buyer");
  }
}

/** Which schedule choices a placement may pick from (all three; the NET_30 gate is separate). */
export function isValidSchedule(schedule: string): schedule is PaymentSchedule {
  return schedule === "FULL_PREPAY" || schedule === "DEPOSIT_30_70" || schedule === "NET_30";
}
