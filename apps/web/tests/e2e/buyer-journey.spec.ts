import { expect, test } from "@playwright/test";
import {
  BUYER_EMAIL,
  JOURNEY_RFQ_TITLE,
  OPS_EMAIL,
  STAFF_EMAIL,
  SALES_EMAIL,
  TARGET_LISTING_ID,
  bootstrapSentRfq,
  orderForRfq,
  signInWithPassword,
} from "./helpers";

/**
 * The full trade loop, end to end and zero API keys, over the deterministic
 * seed (buyer org seed-buyer-01, supplier seed-supplier-001 via its live
 * listing seed-listing-0001):
 *
 *   RFQ sent → supplier quotes → supplier counters their own offer
 *   (revision quote) → buyer awards → order confirmed (30/70) → deposit
 *   captured to escrow → production → balance invoiced + paid → shipment
 *   created → in transit → delivery confirmed → escrow auto-released →
 *   supplier payout created.
 *
 * Three signed-in sessions (buyer OWNER, supplier sales, supplier ops)
 * mirror the real role split: sales owns pricing, ops owns fulfillment.
 * One server-side bootstrap step creates the RFQ the merged UI cannot
 * express yet (no category field on the lean form; SINGLE mode unexposed) —
 * documented as a finding in the closing PR. Everything else is driven
 * through the real UI and server actions.
 */

const QUANTITY = 2500;

test("buyer journey: RFQ to negotiation, award, payments, fulfillment, escrow release", async ({ browser }) => {
  // Three authenticated contexts and a long state machine — grant 3x the
  // default budget.
  test.slow();
  const rfqId = await bootstrapSentRfq({
    buyerEmail: BUYER_EMAIL,
    buyerOrgId: "seed_org_buyer_01",
    listingId: TARGET_LISTING_ID,
    title: JOURNEY_RFQ_TITLE,
    quantity: QUANTITY,
  });

  const buyerContext = await browser.newContext();
  const salesContext = await browser.newContext();
  const opsContext = await browser.newContext();
  const buyerPage = await buyerContext.newPage();
  const salesPage = await salesContext.newPage();
  const opsPage = await opsContext.newPage();

  // ── Buyer: the sent RFQ is on the dashboard ────────────────────────────────
  await signInWithPassword(buyerPage, BUYER_EMAIL);
  await buyerPage.goto("/rfq");
  await expect(buyerPage.getByTestId("rfq-dashboard-title")).toBeVisible();
  const row = buyerPage.locator(`a[href="/rfq/${rfqId}"]`);
  await expect(row).toContainText(JOURNEY_RFQ_TITLE);
  await row.click();
  await expect(buyerPage.getByTestId("rfq-detail-title")).toContainText(JOURNEY_RFQ_TITLE);
  await expect(buyerPage.getByTestId("rfq-detail-status")).toContainText("OPEN");

  // ── Supplier sales: inbox → quote ──────────────────────────────────────────
  await signInWithPassword(salesPage, SALES_EMAIL);
  await salesPage.goto("/rfq/inbox");
  await expect(salesPage.getByTestId("inbox-title")).toBeVisible();
  await salesPage.locator(`a[href="/rfq/${rfqId}"]`).first().click();
  await expect(salesPage.getByTestId("rfq-detail-title")).toContainText(JOURNEY_RFQ_TITLE);

  await salesPage.getByTestId("quote-quantity").fill(String(QUANTITY));
  await salesPage.getByTestId("quote-unit-price").fill("0.42");
  await salesPage.getByTestId("quote-lead").fill("10");
  await salesPage.getByTestId("quote-valid").fill("2030-06-30");
  await salesPage.getByTestId("quote-message").fill("First-offer terms for the E2E cup run.");
  await salesPage.getByTestId("quote-submit").click();
  // Quote/counter actions return no message on success — the rendered quote
  // list is the success signal.
  await expect(salesPage.getByTestId("supplier-quote-list")).toContainText("SUBMITTED");

  // ── Supplier sales: counter the offer — a revision quote ───────────────────
  await salesPage.getByTestId("counter-price").fill("0.38");
  await salesPage.getByTestId("counter-message").fill("Volume discount — one revision.");
  await salesPage.getByTestId("counter-submit").click();
  await expect(salesPage.getByTestId("supplier-quote-list")).toContainText("SUPERSEDED");
  // Revision submitted — visible alongside the superseded original.
  await expect(salesPage.getByTestId("supplier-quote-list")).toContainText("SUBMITTED");

  // ── Buyer: negotiation thread + award via accept ───────────────────────────
  await buyerPage.reload();
  await expect(buyerPage.getByTestId("rfq-detail-status")).toContainText("OPEN");
  await expect(buyerPage.getByTestId("buyer-quote-list")).toContainText("SUPERSEDED");
  // The thread renders message cards — the counter-offer surfaces as its
  // message text, not a COUNTER_OFFER type badge.
  await expect(buyerPage.getByTestId("thread-list")).toContainText("Volume discount — one revision.");
  // Accept the outstanding (revision) quote — creates the pre-payment order.
  // The accept form renders errors only (no success message), so the order
  // id is resolved through the quote → order relation.
  await buyerPage.getByTestId("accept-quote").click();
  await expect(buyerPage.getByTestId("rfq-detail-status")).toContainText("AWARDED");
  const orderId = await orderForRfq(rfqId);
  expect(orderId, "accepting the quote must create an order").toBeTruthy();

  // ── Buyer: confirm order (30/70) and pay the deposit into escrow ──────────
  await buyerPage.goto(`/orders/${orderId}`);
  await expect(buyerPage.getByTestId("order-status")).toContainText("DRAFT");
  await buyerPage.getByTestId("confirm-order-submit").click();
  await expect(buyerPage.getByTestId("order-status")).toContainText("DEPOSIT_DUE");
  await buyerPage.getByTestId("pay-payment").click();
  await expect(buyerPage.getByTestId("order-status")).toContainText("DEPOSIT_PAID");
  await expect(buyerPage.getByTestId("escrow-held")).not.toContainText("$0.00");

  // ── Supplier ops: production, then the 30/70 balance leg ──────────────────
  await signInWithPassword(opsPage, OPS_EMAIL);
  await opsPage.goto("/orders");
  await expect(opsPage.getByTestId("supplier-orders-table")).toBeVisible();
  await opsPage.locator(`a[href="/orders/${orderId}"]`).first().click();
  await opsPage.getByTestId("start-production").click();
  await expect(opsPage.getByTestId("order-status")).toContainText("IN_PRODUCTION");
  await opsPage.getByTestId("complete-production").click();
  await expect(opsPage.getByTestId("order-status")).toContainText("READY_TO_SHIP");
  await opsPage.getByTestId("issue-balance-invoice").click();
  await expect(opsPage.getByTestId("order-status")).toContainText("BALANCE_DUE");

  // ── Buyer: pay the balance ─────────────────────────────────────────────────
  // The balance payment records balancePaid but does not advance the order
  // machine — SHIP (at mark-in-transit) is the next transition and it gates
  // on balancePaid.
  await buyerPage.reload();
  await buyerPage.getByTestId("pay-payment").click();
  await expect(buyerPage.getByTestId("order-status")).toContainText("BALANCE_DUE");

  // ── Supplier ops: shipment → transit → delivery → escrow release ──────────
  await opsPage.reload();
  // Multi-field forms keep the -submit suffix on their button; the bare
  // "create-shipment" test id is the form element itself.
  await opsPage.getByTestId("create-shipment-submit").click();
  await expect(opsPage.getByTestId("shipment-card")).toContainText("CREATED");
  await opsPage.getByTestId("mark-in-transit").click();
  await expect(opsPage.getByTestId("order-status")).toContainText("SHIPPED");
  await opsPage.getByTestId("confirm-delivery").click();
  await expect(opsPage.getByTestId("order-status")).toContainText("ESCROW_RELEASED");
  await expect(opsPage.getByTestId("escrow-released")).not.toContainText("$0.00");
  // Escrow release opens the supplier payout; settlement is a platform-staff
  // action, so the supplier leg reads PENDING until staff act on it below.
  await expect(opsPage.getByTestId("order-payouts")).toContainText("PENDING");

  // ── Platform staff: settle the payout (mock Connect transfer) ───────────────
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await signInWithPassword(staffPage, STAFF_EMAIL);
  await staffPage.goto("/orders/payouts");
  await expect(staffPage.getByTestId("payouts-title")).toBeVisible();
  // Scope to this order's payout row — the ledger lists every seeded payout.
  const payoutRow = staffPage
    .locator("tbody tr")
    .filter({ has: staffPage.locator(`a[href="/orders/${orderId}"]`) });
  await payoutRow.getByTestId("settle-payout").click();
  await expect(payoutRow.getByTestId("payout-status")).toContainText("PAID");

  // ── Buyer and supplier see the settled terminal state ──────────────────────
  await buyerPage.goto(`/orders/${orderId}`);
  await expect(buyerPage.getByTestId("order-status")).toContainText("ESCROW_RELEASED");
  await expect(buyerPage.getByTestId("order-payouts")).toContainText("PAID");
  await opsPage.reload();
  await expect(opsPage.getByTestId("order-payouts")).toContainText("PAID");

  await buyerContext.close();
  await salesContext.close();
  await opsContext.close();
  await staffContext.close();
});
