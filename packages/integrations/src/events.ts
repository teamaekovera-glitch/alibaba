/**
 * Aekovera OS webhook event catalog — derived 1:1 from the REAL audit actions
 * recorded in packages/core (verified against source; no invented names).
 * Whenever core adds an audit action, add it here to expose it to Aekovera OS.
 */

export const WEBHOOK_EVENTS = [
  "rfq.create",
  "rfq.send",
  "rfq.close",
  "rfq.cancel",
  "rfq.award",
  "quote.submit",
  "quote.accept",
  "quote.decline",
  "quote.withdraw",
  "quote.expire",
  "negotiation.counter",
  "negotiation.message",
  "cart.add",
  "cart.remove",
  "order.create",
  "order.place",
  "order.ship",
  "order.deliver",
  "order.cancel",
  "payment.scheduled",
  "payment.captured",
  "payment.failed",
  "escrow.release",
  "invoice.issued",
  "invoice.paid",
  "payout.created",
  "payout.settled",
  "refund.issued",
  "shipment.created",
  "shipment.delivered",
  "dispute.open",
  "dispute.resolve",
  "reorder.create",
  "reorder.remind",
  "reorder.deactivate",
  "listing.create",
  "listing.update",
  "listing.revise",
  "listing.submit",
  "listing.publish",
  "listing.republish",
  "listing.unpublish",
  "listing.withdraw",
  "listing.reject",
  "listing.import",
  // PR #13 notification engine — audited send event (NOTIFICATION_AUDIT.sent).
  "notification.sent",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}
