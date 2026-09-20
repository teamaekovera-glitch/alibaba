"use server";

import {
  EscrowError,
  OrderWorkflowError,
  PermissionDeniedError,
  RecordNotFoundError,
} from "@packsource/core";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ordersRepositories } from "@/lib/orders";

/**
 * Order/escrow/payment/shipment/dispute/payout server actions. Same contract
 * as the RFQ actions: handlers parse FormData and translate domain errors
 * into form-renderable messages — every permission gate, org scope, money
 * rule, and state transition lives in packages/core.
 */

export type ActionState = { ok: true; message?: string } | { error: string } | null;

const DOMAIN_ERRORS = [
  PermissionDeniedError,
  RecordNotFoundError,
  OrderWorkflowError,
  EscrowError,
] as const;

async function withOrders(
  run: (orders: NonNullable<Awaited<ReturnType<typeof ordersRepositories>>>) => Promise<string | void>,
  paths: string[] = ["/orders"],
): Promise<ActionState> {
  const orders = await ordersRepositories();
  if (!orders) {
    redirect("/sign-in");
  }
  try {
    const result = await run(orders);
    for (const path of paths) {
      revalidatePath(path);
    }
    return { ok: true, message: typeof result === "string" ? result : undefined };
  } catch (error) {
    if (DOMAIN_ERRORS.some((kind) => error instanceof kind)) {
      return { error: error instanceof Error ? error.message : "Action failed" };
    }
    throw error; // unknown errors must surface, not become form copy
  }
}

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optionalCents(form: FormData, key: string): number | undefined {
  const raw = str(form, key);
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) ? value : undefined;
}

/** Buyer: confirm a DRAFT order with a payment schedule (staff approves Net-30). */
export async function confirmOrderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const schedule = str(form, "paymentSchedule");
  if (schedule !== "FULL_PREPAY" && schedule !== "DEPOSIT_30_70" && schedule !== "NET_30") {
    return { error: "Choose a payment schedule" };
  }
  // Net-30 requires a staff approval timestamp; only staff sees the
  // approval checkbox, so an approved submission from staff stamps now.
  const net30Approved = str(form, "net30Approve") === "on";
  return withOrders(
    (orders) =>
      orders.orders
        .confirmOrder(orderId, {
          paymentSchedule: schedule,
          ...(schedule === "NET_30" && net30Approved ? { net30ApprovedAt: new Date() } : {}),
        })
        .then(() => "Order confirmed"),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Buyer: pay a scheduled payment (deposit, balance, or Net-30 invoice). */
export async function payPaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const paymentId = str(form, "paymentId");
  return withOrders(
    (orders) =>
      orders.orders
        .payScheduledPayment(orderId, paymentId)
        .then((payment) => `Payment captured (${payment.amountCents} cents held in escrow)`),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Buyer: cancel before production (funds auto-refund). */
export async function cancelOrderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  return withOrders(
    (orders) =>
      orders.orders.cancelOrder(orderId, str(form, "reason") || "buyer cancelled").then(() => "Order cancelled"),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Supplier ops: begin production. */
export async function startProductionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  return withOrders((orders) => orders.orders.startProduction(orderId).then(() => "Production started"), [
    "/orders",
    `/orders/${orderId}`,
  ]);
}

/** Supplier ops: production complete (balance invoice due before shipment). */
export async function completeProductionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  return withOrders((orders) => orders.orders.completeProduction(orderId).then(() => "Production complete"), [
    "/orders",
    `/orders/${orderId}`,
  ]);
}

/** Supplier ops: issue the commercial balance invoice. */
export async function issueBalanceInvoiceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  return withOrders((orders) => orders.orders.issueBalanceInvoice(orderId).then(() => "Balance invoice issued"), [
    "/orders",
    `/orders/${orderId}`,
  ]);
}

/** Supplier ops: create the shipment (deterministic carrier tracking). */
export async function createShipmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const carrier = str(form, "carrier") || "MockCarrier";
  return withOrders(
    (orders) =>
      orders.orders
        .createShipment(orderId, { carrier })
        .then((created) => `Shipment created — tracking ${created.shipment.trackingNumber}`),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Supplier ops: mark shipped. */
export async function markInTransitAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const shipmentId = str(form, "shipmentId");
  return withOrders((orders) => orders.orders.markShipmentInTransit(shipmentId).then(() => "Marked in transit"), [
    "/orders",
    `/orders/${orderId}`,
  ]);
}

/** Supplier ops: confirm delivery — triggers escrow release evaluation. */
export async function confirmDeliveryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const shipmentId = str(form, "shipmentId");
  return withOrders(
    (orders) => orders.orders.confirmDelivery(shipmentId).then(() => "Delivery confirmed — escrow evaluated"),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Buyer: open a dispute (freezes escrow release). */
export async function openDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const reason = str(form, "reason");
  if (!reason) {
    return { error: "Describe the problem" };
  }
  return withOrders((orders) => orders.orders.openDispute(orderId, reason).then(() => "Dispute opened"), [
    "/orders",
    `/orders/${orderId}`,
  ]);
}

/** Staff: mediate a dispute (release / refund / back to delivered). */
export async function resolveDisputeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const disputeId = str(form, "disputeId");
  const type = str(form, "resolutionType");
  const reason = str(form, "reason") || "staff resolution";
  if (type === "REFUND_PARTIAL") {
    const amountCents = optionalCents(form, "amountCents");
    if (amountCents === undefined) {
      return { error: "Partial refund needs an integer-cent amount" };
    }
    return withOrders(
      (orders) =>
        orders.orders
          .resolveDispute(orderId, disputeId, { type, amountCents, reason })
          .then(() => "Partial refund issued"),
      ["/orders", `/orders/${orderId}`],
    );
  }
  if (type !== "RELEASE" && type !== "REFUND_FULL" && type !== "BACK_TO_DELIVERED") {
    return { error: "Choose a resolution" };
  }
  return withOrders(
    (orders) =>
      orders.orders
        .resolveDispute(orderId, disputeId, type === "REFUND_FULL" ? { type, reason } : { type })
        .then(() => "Dispute resolved"),
    ["/orders", `/orders/${orderId}`],
  );
}

/** Staff: settle a supplier payout (mock Connect transfer). */
export async function settlePayoutAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const payoutId = str(form, "payoutId");
  return withOrders((orders) => orders.orders.settlePayout(payoutId).then(() => "Payout settled"), [
    "/orders/payouts",
  ]);
}

/** Download an invoice document via the storage mock's signed URL. */
export async function downloadInvoiceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const invoiceId = str(form, "invoiceId");
  return withOrders(async (orders) => {
    const url = await orders.orders.getInvoicePdfUrl(orderId, invoiceId);
    redirect(url);
  }, ["/orders", `/orders/${orderId}`]);
}
