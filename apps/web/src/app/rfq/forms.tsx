"use client";

import { useActionState } from "react";
import type { ActionState } from "./actions";
import {
  acceptQuoteAction,
  addToCartAction,
  cancelRfqAction,
  counterQuoteAction,
  createRfqAction,
  declineQuoteAction,
  postMessageAction,
  removeFromCartAction,
  sendRfqAction,
  submitQuoteAction,
  withdrawQuoteAction,
} from "./actions";

const inputClass = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-xs font-medium text-neutral-600";

function ErrorText({ state }: { state: ActionState }) {
  if (!state || !("error" in state)) {
    return null;
  }
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="form-error">
      {state.error}
    </p>
  );
}

function OkText({ state }: { state: ActionState }) {
  if (!state || !("ok" in state) || !state.ok || !state.message) {
    return null;
  }
  return (
    <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" data-testid="form-ok">
      {state.message}
    </p>
  );
}

function Submit({ pending, children, testid }: { pending: boolean; children: React.ReactNode; testid: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      data-testid={testid}
      className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

/** Buyer: create an RFQ (single-line lean form; spec attributes later wave). */
export function CreateRfqForm({ listingId }: { listingId?: string }) {
  const [state, action, pending] = useActionState(createRfqAction, null);
  return (
    <form action={action} className="space-y-3" data-testid="rfq-create">
      <ErrorText state={state} />
      <div>
        <label className={labelClass} htmlFor="rfq-title">Title</label>
        <input id="rfq-title" name="title" required className={inputClass} placeholder="32oz stand-up pouches, kraft" data-testid="rfq-title" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="rfq-mode">Mode</label>
          <select id="rfq-mode" name="mode" className={inputClass} defaultValue="BROADCAST" data-testid="rfq-mode">
            <option value="BROADCAST">Broadcast</option>
            <option value="AUCTION">Auction (timed)</option>
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="rfq-quantity">Quantity (units)</label>
          <input id="rfq-quantity" name="quantity" type="number" min="1" required className={inputClass} data-testid="rfq-quantity" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="rfq-destination">Destination</label>
          <input id="rfq-destination" name="destination" className={inputClass} placeholder="Austin, TX 78701" data-testid="rfq-destination" />
        </div>
        <div>
          <label className={labelClass} htmlFor="rfq-needby">Need by</label>
          <input id="rfq-needby" name="needBy" type="date" className={inputClass} data-testid="rfq-needby" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="rfq-line-description">Item description</label>
          <input id="rfq-line-description" name="lineDescription" className={inputClass} placeholder="Kraft stand-up pouch, 32oz, matte" data-testid="rfq-line-description" />
        </div>
        {listingId ? <input type="hidden" name="listingId" value={listingId} /> : null}
        <div>
          <label className={labelClass} htmlFor="rfq-closesat">Auction closes (optional)</label>
          <input id="rfq-closesat" name="closesAt" type="datetime-local" className={inputClass} data-testid="rfq-closesat" />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="rfq-description">Notes</label>
        <textarea id="rfq-description" name="description" rows={2} className={inputClass} data-testid="rfq-description" />
      </div>
      <Submit pending={pending} testid="rfq-create-submit">Create RFQ</Submit>
      <OkText state={state} />
    </form>
  );
}

/** Buyer: send a DRAFT RFQ to matched suppliers. */
export function SendRfqButton({ rfqId }: { rfqId: string }) {
  const [state, action, pending] = useActionState(sendRfqAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="rfqId" value={rfqId} />
      <Submit pending={pending} testid="send-rfq">Send RFQ</Submit>
      <ErrorText state={state} />
    </form>
  );
}

/** Buyer: cancel an RFQ. */
export function CancelRfqButton({ rfqId }: { rfqId: string }) {
  const [state, action, pending] = useActionState(cancelRfqAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="rfqId" value={rfqId} />
      <Submit pending={pending} testid="cancel-rfq">Cancel RFQ</Submit>
      <ErrorText state={state} />
    </form>
  );
}

/** Supplier: submit a quote with a MOQ ladder (one or two tiers) against an RFQ. */
export function SubmitQuoteForm({
  rfqId,
  defaultQuantity,
}: {
  rfqId: string;
  defaultQuantity: number | null;
}) {
  const [state, action, pending] = useActionState(submitQuoteAction, null);
  return (
    <form action={action} className="space-y-3" data-testid="quote-form">
      <ErrorText state={state} />
      <input type="hidden" name="rfqId" value={rfqId} />
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelClass} htmlFor="q-quantity">Quantity</label>
          <input id="q-quantity" name="quantity" type="number" min="1" required className={inputClass} defaultValue={defaultQuantity ?? undefined} data-testid="quote-quantity" />
        </div>
        <div>
          <label className={labelClass} htmlFor="q-unit-price">Unit price ($)</label>
          <input id="q-unit-price" name="unitPrice" required className={inputClass} placeholder="0.42" data-testid="quote-unit-price" />
        </div>
        <div>
          <label className={labelClass} htmlFor="q-lead">Lead time (days)</label>
          <input id="q-lead" name="leadTimeDays" type="number" min="1" required className={inputClass} data-testid="quote-lead" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelClass} htmlFor="q-tooling">Tooling ($, optional)</label>
          <input id="q-tooling" name="tooling" className={inputClass} placeholder="350.00" data-testid="quote-tooling" />
        </div>
        <div>
          <label className={labelClass} htmlFor="q-freight">Freight ($, optional)</label>
          <input id="q-freight" name="freight" className={inputClass} placeholder="180.00" data-testid="quote-freight" />
        </div>
        <div>
          <label className={labelClass} htmlFor="q-valid">Valid until</label>
          <input id="q-valid" name="validUntil" type="date" required className={inputClass} data-testid="quote-valid" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="q-tier2-qty">Tier 2 min qty (optional)</label>
          <input id="q-tier2-qty" name="tier2Qty" type="number" min="1" className={inputClass} data-testid="quote-tier2-qty" />
        </div>
        <div>
          <label className={labelClass} htmlFor="q-tier2-price">Tier 2 unit price ($)</label>
          <input id="q-tier2-price" name="tier2Price" className={inputClass} placeholder="0.36" data-testid="quote-tier2-price" />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="q-message">Message (contact info is redacted)</label>
        <textarea id="q-message" name="message" rows={2} className={inputClass} data-testid="quote-message" />
      </div>
      <Submit pending={pending} testid="quote-submit">Submit quote</Submit>
      <OkText state={state} />
    </form>
  );
}

/** Supplier: counter with revised terms. */
export function CounterQuoteForm({
  quoteId,
  defaultQuantity,
  defaultUnitPriceDollars,
}: {
  quoteId: string;
  defaultQuantity: number | null;
  defaultUnitPriceDollars: string | null;
}) {
  const [state, action, pending] = useActionState(counterQuoteAction, null);
  return (
    <form action={action} className="space-y-2" data-testid="counter-form">
      <ErrorText state={state} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className={labelClass} htmlFor={`c-qty-${quoteId}`}>Qty</label>
          <input id={`c-qty-${quoteId}`} name="quantity" type="number" min="1" className={inputClass} defaultValue={defaultQuantity ?? undefined} data-testid="counter-quantity" />
        </div>
        <div>
          <label className={labelClass} htmlFor={`c-price-${quoteId}`}>Unit $</label>
          <input id={`c-price-${quoteId}`} name="unitPrice" className={inputClass} defaultValue={defaultUnitPriceDollars ?? undefined} data-testid="counter-price" />
        </div>
        <div>
          <label className={labelClass} htmlFor={`c-msg-${quoteId}`}>Note</label>
          <input id={`c-msg-${quoteId}`} name="message" className={inputClass} data-testid="counter-message" />
        </div>
      </div>
      <Submit pending={pending} testid="counter-submit">Send counter-offer</Submit>
      <OkText state={state} />
    </form>
  );
}

/** Either side: post a message on the negotiation thread. */
export function MessageForm({ threadId }: { threadId: string }) {
  const [state, action, pending] = useActionState(postMessageAction, null);
  return (
    <form action={action} className="space-y-2" data-testid="message-form">
      <ErrorText state={state} />
      <input type="hidden" name="threadId" value={threadId} />
      <textarea name="body" rows={2} required className={inputClass} placeholder="Message — emails and phone numbers are removed" data-testid="message-body" />
      <Submit pending={pending} testid="message-submit">Send message</Submit>
      <OkText state={state} />
    </form>
  );
}

/** Generic single-press action button (decline / withdraw / cart / accept). */
function ActionButtonForm({
  action,
  field,
  value,
  label,
  testid,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  field: "quoteId" | "cartItemId";
  value: string;
  label: string;
  testid: string;
}) {
  const [state, actionFn, pending] = useActionState(action, null);
  return (
    <form action={actionFn} className="inline">
      <input type="hidden" name={field} value={value} />
      <Submit pending={pending} testid={testid}>{label}</Submit>
      <ErrorText state={state} />
    </form>
  );
}

export function DeclineQuoteButton({ quoteId }: { quoteId: string }) {
  return <ActionButtonForm action={declineQuoteAction} field="quoteId" value={quoteId} label="Decline" testid="decline-quote" />;
}

export function WithdrawQuoteButton({ quoteId }: { quoteId: string }) {
  return <ActionButtonForm action={withdrawQuoteAction} field="quoteId" value={quoteId} label="Withdraw" testid="withdraw-quote" />;
}

export function AddToCartButton({ quoteId }: { quoteId: string }) {
  return <ActionButtonForm action={addToCartAction} field="quoteId" value={quoteId} label="Add to cart" testid="add-to-cart" />;
}

export function RemoveFromCartButton({ cartItemId }: { cartItemId: string }) {
  return <ActionButtonForm action={removeFromCartAction} field="cartItemId" value={cartItemId} label="Remove" testid="remove-from-cart" />;
}

export function AcceptQuoteButton({ quoteId }: { quoteId: string }) {
  return <ActionButtonForm action={acceptQuoteAction} field="quoteId" value={quoteId} label="Accept & create order" testid="accept-quote" />;
}
