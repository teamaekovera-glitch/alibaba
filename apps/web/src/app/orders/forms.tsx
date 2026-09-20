"use client";

import { useActionState } from "react";
import type { ActionState } from "./actions";
import {
  cancelOrderAction,
  completeProductionAction,
  confirmDeliveryAction,
  confirmOrderAction,
  createShipmentAction,
  downloadInvoiceAction,
  issueBalanceInvoiceAction,
  markInTransitAction,
  openDisputeAction,
  payPaymentAction,
  resolveDisputeAction,
  settlePayoutAction,
  startProductionAction,
} from "./actions";

const inputClass = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-xs font-medium text-neutral-600";

function Feedback({ state }: { state: ActionState }) {
  if (!state) {
    return null;
  }
  if ("error" in state) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="form-error">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" data-testid="form-ok">
        {state.message}
      </p>
    );
  }
  return null;
}

function Submit({ pending, testid, children }: { pending: boolean; testid: string; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      data-testid={testid}
      className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

/** Hidden field bundle so every action form carries its identifiers. */
function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}

/** Buyer: confirm the DRAFT order with a payment schedule. */
export function ConfirmOrderForm({ orderId, isStaff }: { orderId: string; isStaff: boolean }) {
  const [state, action, pending] = useActionState(confirmOrderAction, null);
  return (
    <form action={action} className="space-y-3" data-testid="confirm-order">
      <Feedback state={state} />
      <Hidden name="orderId" value={orderId} />
      <div>
        <label className={labelClass} htmlFor="paymentSchedule">Payment schedule</label>
        <select id="paymentSchedule" name="paymentSchedule" className={inputClass} defaultValue="DEPOSIT_30_70" data-testid="schedule-select">
          <option value="DEPOSIT_30_70">30% deposit / 70% before shipment</option>
          <option value="FULL_PREPAY">Full prepayment</option>
          <option value="NET_30">Net 30 (staff approval required)</option>
        </select>
      </div>
      {isStaff ? (
        <label className="flex items-center gap-2 text-sm" data-testid="net30-approve-row">
          <input type="checkbox" name="net30Approve" data-testid="net30-approve" />
          Approve Net-30 terms (staff)
        </label>
      ) : null}
      <Submit pending={pending} testid="confirm-order-submit">Confirm order</Submit>
    </form>
  );
}

/** Generic one-button action form with hidden identifiers. */
function ActionForm({
  action,
  testid,
  label,
  fields,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  testid: string;
  label: string;
  fields: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="inline-flex items-center gap-2" data-testid={testid}>
      {Object.entries(fields).map(([name, value]) => (
        <Hidden key={name} name={name} value={value} />
      ))}
      <Submit pending={pending} testid={`${testid}-submit`}>{label}</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function PayPaymentButton({ orderId, paymentId }: { orderId: string; paymentId: string }) {
  return <ActionForm action={payPaymentAction} testid="pay-payment" label="Pay" fields={{ orderId, paymentId }} />;
}

export function CancelOrderForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(cancelOrderAction, null);
  return (
    <form action={action} className="space-y-2" data-testid="cancel-order">
      <Feedback state={state} />
      <Hidden name="orderId" value={orderId} />
      <input name="reason" className={inputClass} placeholder="Reason (optional)" data-testid="cancel-reason" />
      <Submit pending={pending} testid="cancel-order-submit">Cancel order</Submit>
    </form>
  );
}

export function StartProductionButton({ orderId }: { orderId: string }) {
  return <ActionForm action={startProductionAction} testid="start-production" label="Start production" fields={{ orderId }} />;
}

export function CompleteProductionButton({ orderId }: { orderId: string }) {
  return <ActionForm action={completeProductionAction} testid="complete-production" label="Complete production" fields={{ orderId }} />;
}

export function IssueBalanceInvoiceButton({ orderId }: { orderId: string }) {
  return <ActionForm action={issueBalanceInvoiceAction} testid="issue-balance-invoice" label="Issue balance invoice" fields={{ orderId }} />;
}

export function CreateShipmentForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(createShipmentAction, null);
  return (
    <form action={action} className="space-y-2" data-testid="create-shipment">
      <Feedback state={state} />
      <Hidden name="orderId" value={orderId} />
      <input name="carrier" className={inputClass} placeholder="Carrier (default MockCarrier)" data-testid="carrier-input" />
      <Submit pending={pending} testid="create-shipment-submit">Create shipment</Submit>
    </form>
  );
}

export function MarkInTransitButton({ orderId, shipmentId }: { orderId: string; shipmentId: string }) {
  return <ActionForm action={markInTransitAction} testid="mark-in-transit" label="Mark in transit" fields={{ orderId, shipmentId }} />;
}

export function ConfirmDeliveryButton({ orderId, shipmentId }: { orderId: string; shipmentId: string }) {
  return <ActionForm action={confirmDeliveryAction} testid="confirm-delivery" label="Confirm delivery" fields={{ orderId, shipmentId }} />;
}

export function OpenDisputeForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(openDisputeAction, null);
  return (
    <form action={action} className="space-y-2" data-testid="open-dispute">
      <Feedback state={state} />
      <Hidden name="orderId" value={orderId} />
      <textarea name="reason" className={inputClass} rows={2} placeholder="What went wrong?" data-testid="dispute-reason" />
      <Submit pending={pending} testid="open-dispute-submit">Open dispute</Submit>
    </form>
  );
}

export function ResolveDisputeForm({ orderId, disputeId }: { orderId: string; disputeId: string }) {
  const [state, action, pending] = useActionState(resolveDisputeAction, null);
  return (
    <form action={action} className="space-y-2" data-testid="resolve-dispute">
      <Feedback state={state} />
      <Hidden name="orderId" value={orderId} />
      <Hidden name="disputeId" value={disputeId} />
      <select name="resolutionType" className={inputClass} defaultValue="RELEASE" data-testid="resolution-select">
        <option value="RELEASE">Release escrow to supplier</option>
        <option value="REFUND_FULL">Refund buyer in full</option>
        <option value="REFUND_PARTIAL">Partial refund</option>
        <option value="BACK_TO_DELIVERED">Return order to delivered</option>
      </select>
      <input name="amountCents" className={inputClass} placeholder="Partial refund amount (integer cents)" data-testid="refund-amount" />
      <input name="reason" className={inputClass} placeholder="Resolution reason" data-testid="resolution-reason" />
      <Submit pending={pending} testid="resolve-dispute-submit">Resolve</Submit>
    </form>
  );
}

export function SettlePayoutButton({ payoutId }: { payoutId: string }) {
  return <ActionForm action={settlePayoutAction} testid="settle-payout" label="Settle payout" fields={{ payoutId }} />;
}

export function DownloadInvoiceButton({ orderId, invoiceId }: { orderId: string; invoiceId: string }) {
  return <ActionForm action={downloadInvoiceAction} testid="download-invoice" label="Download" fields={{ orderId, invoiceId }} />;
}
