import { RecordNotFoundError, isDeliveredOrderStatus } from "@packsource/core";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { ordersRepositories } from "@/lib/orders";
import { trustRepositories } from "@/lib/trust";
import {
  DisputeEvidenceForm,
  DisputeRespondForm,
  StartDisputeReviewButton,
  WithdrawDisputeButton,
} from "../trust-forms";
import {
  CancelOrderForm,
  CompleteProductionButton,
  ConfirmDeliveryButton,
  ConfirmOrderForm,
  CreateShipmentForm,
  DownloadInvoiceButton,
  IssueBalanceInvoiceButton,
  MarkInTransitButton,
  OpenDisputeForm,
  PayPaymentButton,
  ResolveDisputeForm,
  StartProductionButton,
} from "../forms";

function Card({ title, testid, children }: { title: string; testid?: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-lg border border-neutral-200 p-4" data-testid={testid}>
      <h2 className="text-base font-medium">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function day(at: Date | null | undefined): string {
  return at ? at.toISOString().slice(0, 10) : "—";
}

/** Buyer/supplier order detail: schedule, payments, escrow, invoices, shipments, disputes. */
export default async function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const repos = await ordersRepositories();
  if (!repos) {
    redirect("/sign-in");
  }
  const { orders, authContext } = repos;

  let order;
  try {
    order = await orders.getOrder(orderId);
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return (
        <main className="mx-auto max-w-lg px-4 py-16 text-center">
          <h1 className="text-xl font-semibold">Order not found</h1>
          <Link className="mt-4 inline-block text-sm underline" href="/orders">Back to orders</Link>
        </main>
      );
    }
    throw error;
  }
  const escrow = await orders.escrowSummary(orderId);

  const isBuyer = order.orgId === authContext.orgId;
  const isStaff = authContext.role === "AEKOVERA_STAFF";
  const isSupplier = order.subOrders.some((leg) => leg.orgId === authContext.orgId);
  const openDispute = order.disputes.find((d) => d.status === "OPEN" || d.status === "UNDER_REVIEW");

  // Trust layer: dispute discussion (participant-scoped via the core
  // repository) and per-line review state for delivered buyer orders.
  const trust = await trustRepositories();
  const disputeDetail = openDispute && trust ? await trust.disputes.disputeDetail(openDispute.id) : null;
  const isDeliveredBuyerOrder = isBuyer && isDeliveredOrderStatus(order.status);
  const [listingRefs, orderReviews] = isDeliveredBuyerOrder
    ? await Promise.all([
        db.listing.findMany({
          where: { id: { in: order.orderLines.map((line) => line.listingId).filter((id): id is string => id !== null) } },
          select: { id: true, slug: true, title: true },
        }),
        db.review.findMany({
          where: { orderId: order.id, orgId: authContext.orgId },
          select: { orderLineId: true, moderationStatus: true },
        }),
      ])
    : [[], []];
  const listingByLine = new Map(
    order.orderLines.map((line) => [line.id, line.listingId ? listingRefs.find((listing) => listing.id === line.listingId) : undefined]),
  );
  const reviewByLine = new Map(orderReviews.map((review) => [review.orderLineId, review.moderationStatus]));

  const shipments = order.subOrders.flatMap((leg) => leg.shipments);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="order-title">Order {order.id}</h1>
          <p className="mt-1 text-sm text-neutral-600" data-testid="order-subtitle">
            Status <span className="font-medium text-neutral-900" data-testid="order-status">{order.status}</span>
            {" · "}{order.paymentSchedule}
            {isBuyer ? " · you are the buyer" : ""}
            {isSupplier ? " · you are a supplier on this order" : ""}
            {isStaff ? " · platform staff" : ""}
          </p>
        </div>
        <Link className="text-sm underline" href="/orders" data-testid="back-to-orders">All orders</Link>
      </header>

      <Card title="Lines" testid="order-lines">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="py-1">Description</th>
              <th className="py-1 text-right">Qty</th>
              <th className="py-1 text-right">Unit</th>
              <th className="py-1 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {order.orderLines.map((line) => (
              <tr key={line.id} className="border-t border-neutral-200">
                <td className="py-1.5">{line.description}</td>
                <td className="py-1.5 text-right">{line.quantity}</td>
                <td className="py-1.5 text-right">{formatCents(line.unitPriceCents)}</td>
                <td className="py-1.5 text-right">{formatCents(line.totalCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-300 font-medium">
              <td className="py-1.5" colSpan={3}>Order total (incl. tooling, plates, freight)</td>
              <td className="py-1.5 text-right" data-testid="order-total">{formatCents(order.totalCents)}</td>
            </tr>
          </tfoot>
        </table>
      </Card>

      {order.status === "DRAFT" && isBuyer ? (
        <Card title="Confirm order" testid="confirm-section">
          <p className="text-sm text-neutral-600">
            Choose how you pay. Deposits and full prepayment are captured to the platform&apos;s
            escrow account; suppliers are paid out after delivery.
          </p>
          <div className="mt-3 max-w-md">
            <ConfirmOrderForm orderId={order.id} isStaff={isStaff} />
          </div>
        </Card>
      ) : null}

      <Card title="Payment schedule" testid="payment-schedule">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="py-1">Kind</th>
              <th className="py-1">Status</th>
              <th className="py-1">Due</th>
              <th className="py-1 text-right">Amount</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {order.payments.map((payment) => (
              <tr key={payment.id} className="border-t border-neutral-200">
                <td className="py-1.5" data-testid="payment-kind">{payment.kind}</td>
                <td className="py-1.5" data-testid="payment-status">{payment.status}</td>
                <td className="py-1.5">{day(payment.dueAt)}</td>
                <td className="py-1.5 text-right">{formatCents(payment.amountCents)}</td>
                <td className="py-1.5 text-right">
                  {isBuyer && payment.status === "PENDING" ? (
                    <PayPaymentButton orderId={order.id} paymentId={payment.id} />
                  ) : null}
                </td>
              </tr>
            ))}
            {order.payments.length === 0 ? (
              <tr><td className="py-2 text-neutral-600" colSpan={5}>No payments yet.</td></tr>
            ) : null}
          </tbody>
        </table>
        {isBuyer && order.status !== "DRAFT" && order.status !== "CANCELLED" && !openDispute ? (
          <div className="mt-3 max-w-md border-t border-neutral-200 pt-3">
            <p className="text-xs text-neutral-500">Problem with this order? A dispute freezes escrow release.</p>
            <div className="mt-2"><OpenDisputeForm orderId={order.id} /></div>
          </div>
        ) : null}
      </Card>

      <Card title="Escrow" testid="escrow-summary">
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-neutral-500">Held</p>
            <p className="font-medium" data-testid="escrow-held">{formatCents(escrow.heldCents)}</p>
          </div>
          <div>
            <p className="text-neutral-500">Released to suppliers</p>
            <p className="font-medium" data-testid="escrow-released">{formatCents(escrow.releasedCents)}</p>
          </div>
          <div>
            <p className="text-neutral-500">Platform commission</p>
            <p className="font-medium" data-testid="escrow-commission">{formatCents(escrow.commissionCents)}</p>
          </div>
        </div>
        {openDispute ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="dispute-hold">
            Escrow release frozen — dispute {openDispute.id} is {openDispute.status}: {openDispute.reason}
          </p>
        ) : null}
        {isStaff && openDispute ? (
          <div className="mt-3 max-w-md">
            <ResolveDisputeForm orderId={order.id} disputeId={openDispute.id} />
          </div>
        ) : null}
      </Card>

      {disputeDetail ? (
        <Card title={`Dispute — ${disputeDetail.dispute.status}`} testid="dispute-card">
          <p className="text-sm text-neutral-700">
            <span className="font-medium">Reason:</span> {disputeDetail.dispute.reason}
          </p>
          {disputeDetail.evidence.length > 0 ? (
            <div className="mt-3" data-testid="dispute-evidence-list">
              <h3 className="text-sm font-medium text-neutral-900">Evidence</h3>
              <ul className="mt-1 space-y-1 text-sm text-neutral-700">
                {disputeDetail.evidence.map((entry) => (
                  <li key={entry.id} className="font-mono text-xs">
                    {entry.fileId}
                    {entry.note ? ` — ${entry.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {disputeDetail.responses.length > 0 ? (
            <div className="mt-3 space-y-2" data-testid="dispute-thread">
              <h3 className="text-sm font-medium text-neutral-900">Discussion</h3>
              {disputeDetail.responses.map((response) => (
                <div key={response.id} className="rounded-md border border-neutral-200 px-3 py-2">
                  <p className="text-xs font-medium text-neutral-600">
                    {response.orgName} · {response.authorName}
                  </p>
                  <p className="mt-1 text-sm text-neutral-700">{response.body}</p>
                </div>
              ))}
            </div>
          ) : null}
          {disputeDetail.dispute.status !== "RESOLVED" && disputeDetail.dispute.status !== "WITHDRAWN" ? (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <DisputeRespondForm orderId={order.id} disputeId={openDispute!.id} />
              <DisputeEvidenceForm orderId={order.id} disputeId={openDispute!.id} />
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            {isBuyer && disputeDetail.dispute.status === "OPEN" ? (
              <WithdrawDisputeButton orderId={order.id} disputeId={openDispute!.id} />
            ) : null}
            {isStaff && disputeDetail.dispute.status === "OPEN" ? (
              <StartDisputeReviewButton orderId={order.id} disputeId={openDispute!.id} />
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card title="Invoices" testid="invoices">
        {order.invoices.length === 0 ? (
          <p className="text-sm text-neutral-600">No invoices yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="py-1">Number</th>
                <th className="py-1">Kind</th>
                <th className="py-1">Status</th>
                <th className="py-1 text-right">Total</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {order.invoices.map((invoice) => (
                <tr key={invoice.id} className="border-t border-neutral-200">
                  <td className="py-1.5 font-mono text-xs" data-testid="invoice-number">{invoice.number}</td>
                  <td className="py-1.5">{invoice.kind}</td>
                  <td className="py-1.5">{invoice.status}</td>
                  <td className="py-1.5 text-right">{formatCents(invoice.totalCents)}</td>
                  <td className="py-1.5 text-right">
                    {invoice.pdfFileId ? (
                      <DownloadInvoiceButton orderId={order.id} invoiceId={invoice.id} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Shipments" testid="shipments">
        {order.status === "IN_PRODUCTION" && isSupplier ? (
          <div className="mb-4 max-w-md">
            <CompleteProductionButton orderId={order.id} />
          </div>
        ) : null}
        {order.status === "BALANCE_DUE" && isSupplier ? (
          <div className="mb-4 max-w-md">
            <p className="mb-2 text-xs text-neutral-500">Balance paid — create the shipment to hand off to the carrier.</p>
            <CreateShipmentForm orderId={order.id} />
          </div>
        ) : null}
        {order.status === "READY_TO_SHIP" && isSupplier ? (
          <div className="mb-4 max-w-md">
            {order.paymentSchedule === "DEPOSIT_30_70" ? (
              <>
                <p className="mb-2 text-xs text-neutral-500">
                  Issue the balance invoice (70%) — the order can ship once the buyer pays it.
                </p>
                <IssueBalanceInvoiceButton orderId={order.id} />
              </>
            ) : (
              <CreateShipmentForm orderId={order.id} />
            )}
          </div>
        ) : null}
        {shipments.length === 0 ? (
          <p className="text-sm text-neutral-600">No shipments yet.</p>
        ) : null}
        <div className="space-y-4">
          {shipments.map((shipment) => (
            <div key={shipment.id} className="rounded-md border border-neutral-200 p-3" data-testid="shipment-card">
              <p className="text-sm">
                <span className="font-medium">{shipment.status}</span>
                {" · "}{shipment.carrier ?? "carrier pending"}
                {shipment.trackingNumber ? ` · tracking ${shipment.trackingNumber}` : ""}
                {shipment.podFileId ? " · proof of delivery on file" : ""}
              </p>
              <p className="mt-1 text-xs text-neutral-500" data-testid="shipment-milestones">
                Label created {day(shipment.createdAt)} · in transit {day(shipment.shippedAt)} · delivered {day(shipment.deliveredAt)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {isSupplier && shipment.status === "CREATED" ? (
                  <MarkInTransitButton orderId={order.id} shipmentId={shipment.id} />
                ) : null}
                {isSupplier && shipment.status === "IN_TRANSIT" ? (
                  <ConfirmDeliveryButton orderId={order.id} shipmentId={shipment.id} />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Fulfillment legs" testid="sub-orders">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="py-1">Supplier org</th>
              <th className="py-1">Status</th>
              <th className="py-1 text-right">Leg total</th>
            </tr>
          </thead>
          <tbody>
            {order.subOrders.map((leg) => (
              <tr key={leg.id} className="border-t border-neutral-200">
                <td className="py-1.5 font-mono text-xs">{leg.orgId}</td>
                <td className="py-1.5">{leg.status}</td>
                <td className="py-1.5 text-right">{formatCents(leg.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {order.status === "DEPOSIT_PAID" && isSupplier ? (
          <div className="mt-3"><StartProductionButton orderId={order.id} /></div>
        ) : null}
      </Card>

      {isDeliveredBuyerOrder ? (
        <Card title="Reviews" testid="order-reviews">
          <p className="text-sm text-neutral-600">
            Verified-purchase reviews are left on the product page — one per delivered order line, published after
            moderation.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {order.orderLines.map((line) => {
              const listing = listingByLine.get(line.id);
              const status = reviewByLine.get(line.id);
              return (
                <li key={line.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="review-line">
                  <span className="text-neutral-800">{listing?.title ?? line.description}</span>
                  {status ? (
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        status === "PUBLISHED"
                          ? "bg-green-100 text-green-800"
                          : status === "REJECTED"
                            ? "bg-red-100 text-red-800"
                            : "bg-amber-100 text-amber-800"
                      }`}
                      data-testid="review-line-status"
                    >
                      Review {status.toLowerCase()}
                    </span>
                  ) : listing ? (
                    <Link className="text-sm underline" href={`/products/${listing.slug}`} data-testid="review-line-link">
                      Leave a review
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {isBuyer && order.status === "DRAFT" ? (
        <Card title="Cancel" testid="cancel-section">
          <p className="text-sm text-neutral-600">Cancel any time before production starts — captured funds are refunded automatically.</p>
          <div className="mt-3 max-w-md"><CancelOrderForm orderId={order.id} /></div>
        </Card>
      ) : null}

      <Card title="Payouts" testid="order-payouts">
        {order.payouts.length === 0 ? (
          <p className="text-sm text-neutral-600">No payouts yet — supplier payouts are created when escrow releases.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="py-1">Supplier org</th>
                <th className="py-1">Status</th>
                <th className="py-1 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {order.payouts.map((payout) => (
                <tr key={payout.id} className="border-t border-neutral-200">
                  <td className="py-1.5 font-mono text-xs">{payout.orgId}</td>
                  <td className="py-1.5">{payout.status}</td>
                  <td className="py-1.5 text-right">{formatCents(payout.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </main>
  );
}
