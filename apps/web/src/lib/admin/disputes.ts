/**
 * Staff dispute-resolution view (spec: administration — "Dispute resolution
 * (staff): view disputes, request evidence, resolve with outcomes"). The
 * resolution itself delegates to OrderRepository.resolveDispute — the single
 * owner of the escrow freeze/resume contract from PR #11 — so staff actions
 * cannot drift from buyer/supplier dispute behavior. This layer adds the
 * staff reads (all orgs, cross-org by design) and the post-resolution
 * notifications.
 */
import type { PrismaClient } from "@packsource/db";
import { OrderRepository, RecordNotFoundError, assertCan, type AuthContext } from "@packsource/core";
import type { NotificationEngine } from "@packsource/notifications";
import { db } from "@/lib/db";
import { payments, storage, tracking } from "@/lib/adapters";

/** The escrow-aware resolution union, taken from the contract itself. */
export type StaffDisputeResolution = Parameters<OrderRepository["resolveDispute"]>[2];

/** The plain-shaped outcome the console form submits. */
export type DisputeOutcomeKind = "RELEASE" | "FULL_REFUND" | "PARTIAL_REFUND" | "BACK_TO_DELIVERED";

export interface StaffDisputeListOptions {
  status?: "OPEN" | "UNDER_REVIEW" | "RESOLVED";
}

/** Every dispute across orgs, newest first — staff-only read. */
export async function staffDisputes(auth: AuthContext, options: StaffDisputeListOptions = {}) {
  assertCan(auth.role, "dispute:mediate");
  return db.dispute.findMany({
    where: options.status ? { status: options.status } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      reason: true,
      detail: true,
      outcome: true,
      refundCents: true,
      resolutionNote: true,
      resolvedAt: true,
      createdAt: true,
      openedByUser: { select: { id: true, email: true } },
      order: { select: { id: true, status: true, totalCents: true } },
    },
  });
}

/** One dispute with its order context — staff-only read. */
export async function disputeDetail(auth: AuthContext, disputeId: string) {
  assertCan(auth.role, "dispute:mediate");
  const dispute = await db.dispute.findUnique({
    where: { id: disputeId },
    include: {
      order: {
        select: {
          id: true,
          status: true,
          totalCents: true,
          buyerUserId: true,
          subOrders: { select: { id: true, orgId: true, status: true } },
          disputes: {
            select: { id: true, status: true, reason: true, outcome: true, createdAt: true },
          },
        },
      },
      openedByUser: { select: { id: true, email: true } },
    },
  });
  if (!dispute) {
    return null;
  }
  return dispute;
}

export interface ResolveDisputeAsStaffInput {
  disputeId: string;
  /** The form-shaped outcome; converted to the escrow contract's union. */
  kind: DisputeOutcomeKind;
  /** Refund amount in integer cents — PARTIAL_REFUND only. */
  amountCents?: number;
  /** Resolution note; required by the contract for refunds. */
  note?: string;
  now: Date;
}

/** Map the console's plain outcome shape onto the escrow contract's union. */
export function toEscrowResolution(input: ResolveDisputeAsStaffInput): StaffDisputeResolution {
  const reason = input.note?.trim() || "Resolved by Aekovera staff";
  switch (input.kind) {
    case "RELEASE":
      return { type: "RELEASE" };
    case "FULL_REFUND":
      return { type: "REFUND_FULL", reason };
    case "PARTIAL_REFUND":
      return { type: "REFUND_PARTIAL", amountCents: input.amountCents ?? 0, reason };
    case "BACK_TO_DELIVERED":
      return { type: "BACK_TO_DELIVERED" };
  }
}

/**
 * Resolve a dispute as staff. Delegates the state transition and escrow
 * accounting to OrderRepository.resolveDispute (escrow release + commission
 * split + payouts / full refund / partial refund / return-to-delivered),
 * then notifies the buyer opener and the affected supplier leg's org. Zero
 * API keys — the escrow port is the deterministic Stripe mock from adapters.
 */
export async function resolveDisputeAsStaff(
  database: PrismaClient,
  auth: AuthContext,
  notifications: NotificationEngine,
  input: ResolveDisputeAsStaffInput,
) {
  assertCan(auth.role, "dispute:mediate");

  // The dispute's order id pins which escrow contract applies; the sub-order
  // pins which supplier org is affected (SubOrder.orgId is the supplier).
  const dispute = await database.dispute.findUnique({
    where: { id: input.disputeId },
    select: {
      id: true,
      orgId: true, // opener (buyer org)
      orderId: true,
      status: true,
      openedByUserId: true,
      subOrderId: true,
    },
  });
  if (!dispute) {
    throw new RecordNotFoundError("Dispute", input.disputeId);
  }

  const supplierLeg = dispute.subOrderId
    ? await database.subOrder.findUnique({
        where: { id: dispute.subOrderId },
        select: { id: true, orgId: true },
      })
    : null;

  const repos = new OrderRepository(database, auth, { payments, tracking, storage });
  const resolved = await repos.resolveDispute(
    dispute.orderId,
    dispute.id,
    toEscrowResolution(input),
  );
  // Staff accountability: the repository contract doesn't take an actor, so
  // the console records who resolved it on the dispute row itself.
  await database.dispute.update({
    where: { id: dispute.id },
    data: { resolvedByUserId: auth.userId },
  });

  // Post-resolution notifications run AFTER the escrow transition committed.
  const supplierUserIds = supplierLeg
    ? await notifications.orgMemberUserIds(supplierLeg.orgId)
    : [];
  const notified = await notifications.notify({
    orgId: dispute.orgId,
    userIds: [dispute.openedByUserId, ...supplierUserIds],
    kind: "DISPUTE_RESOLVED",
    title: `Dispute resolved: ${input.kind}`,
    body:
      input.note?.trim() ||
      `Staff resolved the dispute on order ${resolved.disputeId}; order moved to ${resolved.resolvedTo}.`,
    linkUrl: `/orders/${dispute.orderId}`,
    entityType: "Dispute",
    entityId: dispute.id,
    now: input.now,
  });

  return {
    disputeId: resolved.disputeId,
    resolvedTo: resolved.resolvedTo,
    notificationIds: notified.notificationIds,
    emailIds: notified.emails.map((email) => email.emailId),
  };
}
