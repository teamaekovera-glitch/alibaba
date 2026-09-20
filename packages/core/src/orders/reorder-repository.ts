/**
 * Reorder reminders (spec: "reorder rules (cadence + production schedule)",
 * buyer workspace). Deterministic clock: every method takes `now` explicitly
 * — nothing here reads the wall clock, so tests and sweeps are reproducible.
 */
import { Prisma, type PrismaClient } from "@packsource/db";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";

/** Audit-log actions written by the reorder engine. */
export const REORDER_AUDIT = {
  create: "reorder.create",
  remind: "reorder.remind",
  deactivate: "reorder.deactivate",
} as const;

/** Raised when a reorder rule request is structurally invalid. */
export class InvalidReorderRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReorderRuleError";
  }
}

export interface CreateReorderRuleInput {
  listingId: string;
  /** Repeat cadence in days (required — a rule without a cadence never fires). */
  cadenceDays: number;
  /** Optional production-schedule hint (JSON, per the schema column). */
  productionSchedule?: Record<string, unknown> | null;
  /** Deterministic now — nextOrderAt = now + cadence. */
  now: Date;
}

export class ReorderRepository {
  readonly #db: PrismaClient;
  readonly #auth: AuthContext;

  constructor(db: PrismaClient, auth: AuthContext) {
    this.#db = db;
    this.#auth = auth;
  }

  #require(permission: Permission): void {
    assertCan(this.#auth.role, permission);
  }

  async #audit(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId: this.#auth.orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType,
        entityId,
      },
    });
  }

  /** Create a repeat-order rule for one of this org's saved listings. */
  async createRule(input: CreateReorderRuleInput) {
    this.#require("workspace:manage");
    if (!Number.isInteger(input.cadenceDays) || input.cadenceDays < 1) {
      throw new InvalidReorderRuleError("cadenceDays must be a positive whole number of days");
    }
    return this.#db.$transaction(async (tx) => {
      const listing = await tx.listing.findFirst({
        where: { id: input.listingId },
        select: { id: true, title: true },
      });
      if (!listing) {
        throw new RecordNotFoundError("Listing", input.listingId);
      }
      const nextOrderAt = addDays(input.now, input.cadenceDays);
      const rule = await tx.reorderRule.create({
        data: {
          orgId: this.#auth.orgId,
          listingId: input.listingId,
          cadenceDays: input.cadenceDays,
          productionSchedule: (input.productionSchedule ?? undefined) as Prisma.InputJsonValue,
          nextOrderAt,
          isActive: true,
        },
      });
      await this.#audit(tx, REORDER_AUDIT.create, "ReorderRule", rule.id);
      return rule;
    });
  }

  /** This org's reorder rules, soonest due first. */
  async listRules() {
    this.#require("workspace:manage");
    return this.#db.reorderRule.findMany({
      where: { orgId: this.#auth.orgId },
      orderBy: [{ isActive: "desc" }, { nextOrderAt: "asc" }, { id: "asc" }],
      include: { listing: { select: { id: true, title: true } } },
    });
  }

  /** Rules due for a reminder at `now` (active, nextOrderAt <= now). */
  async dueRules(now: Date) {
    this.#require("workspace:manage");
    return this.#db.reorderRule.findMany({
      where: { orgId: this.#auth.orgId, isActive: true, nextOrderAt: { lte: now } },
      orderBy: [{ nextOrderAt: "asc" }, { id: "asc" }],
      include: { listing: { select: { id: true, title: true } } },
    });
  }

  /**
   * Record that a reminder fired: push nextOrderAt out by the rule's own
   * cadence from `now` (deterministic; no wall clock). Idempotent per
   * moment: reminding twice at the same `now` yields the same nextOrderAt.
   */
  async markReminded(ruleId: string, now: Date) {
    this.#require("workspace:manage");
    return this.#db.$transaction(async (tx) => {
      const rule = await tx.reorderRule.findFirst({
        where: { id: ruleId, orgId: this.#auth.orgId },
      });
      if (!rule) {
        throw new RecordNotFoundError("ReorderRule", ruleId);
      }
      const cadenceDays = rule.cadenceDays ?? 0;
      if (cadenceDays < 1) {
        throw new InvalidReorderRuleError("rule has no positive cadence");
      }
      const updated = await tx.reorderRule.update({
        where: { id: rule.id },
        data: { nextOrderAt: addDays(now, cadenceDays) },
      });
      await this.#audit(tx, REORDER_AUDIT.remind, "ReorderRule", rule.id);
      return updated;
    });
  }

  /** Deactivate (or re-activate) a rule. */
  async setActive(ruleId: string, isActive: boolean) {
    this.#require("workspace:manage");
    return this.#db.$transaction(async (tx) => {
      const rule = await tx.reorderRule.findFirst({
        where: { id: ruleId, orgId: this.#auth.orgId },
      });
      if (!rule) {
        throw new RecordNotFoundError("ReorderRule", ruleId);
      }
      const updated = await tx.reorderRule.update({
        where: { id: rule.id },
        data: { isActive },
      });
      await this.#audit(tx, REORDER_AUDIT.deactivate, "ReorderRule", rule.id);
      return updated;
    });
  }
}

/** Calendar-day add in UTC — deterministic across DST and timezones. */
export function addDays(at: Date, days: number): Date {
  const next = new Date(at.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
