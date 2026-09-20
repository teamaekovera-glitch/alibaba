/**
 * Deterministic background-job seams (spec: "Escrow payments" acceptance —
 * idempotent release jobs, safe under replay). In production these run on a
 * scheduler (e.g. Inngest cron); in tests they are plain async functions with
 * the clock passed in, so the 7-day auto-release and Net-30 due dates are
 * deterministic — no wall-time flakiness, zero API keys.
 */
import { MockPaymentsAdapter, MockStorageAdapter, MockTrackingAdapter } from "@packsource/ai";
import type { PrismaClient } from "@packsource/db";
import type { AuthContext } from "../repositories";
import { OrderRepository } from "./order-repository";

/** Actor recorded on system-run audit rows (actorType: "system"). */
export const SYSTEM_ACTOR_ID = "system";

/** The job actor: platform staff identity, never a real user. */
const SYSTEM_ACTOR: AuthContext = {
  userId: SYSTEM_ACTOR_ID,
  orgId: SYSTEM_ACTOR_ID,
  role: "AEKOVERA_STAFF",
};

function systemOrderRepository(db: PrismaClient): OrderRepository {
  return new OrderRepository(
    db,
    SYSTEM_ACTOR,
    {
      payments: new MockPaymentsAdapter(),
      tracking: new MockTrackingAdapter(),
      storage: new MockStorageAdapter(),
    },
    { system: true },
  );
}

/**
 * Escrow sweep: releases every order past its auto-release window (delivery
 * confirmed, or shipped + 7 days) whose funds are still held. Double-runs are
 * no-ops — release entries and payouts are unique-keyed.
 */
export async function runEscrowSweep(db: PrismaClient, now: Date) {
  return systemOrderRepository(db).sweepEscrowReleases(now);
}

/**
 * Net-30 off-session charge run: captures every due NET_30 balance whose due
 * date has passed (deterministic clock). Replays short-circuit on the
 * payment's SUCCEEDED status.
 */
export async function runNet30ChargeRun(db: PrismaClient, now: Date) {
  return systemOrderRepository(db).runNet30Charges(now);
}
