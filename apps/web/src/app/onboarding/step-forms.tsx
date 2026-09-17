"use client";

import { useActionState } from "react";
import type { ActionState } from "./actions";
import {
  saveCommercialTerms,
  saveCompanyDetails,
  addCapability,
  linkStripeConnect,
  submitForReview,
  upsertCertification,
  upsertEquipment,
  upsertPlant,
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

function SubmitButton({
  pending,
  children,
  testid,
}: {
  pending: boolean;
  children: React.ReactNode;
  testid: string;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      data-testid={testid}
      className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "Saving…" : children}
    </button>
  );
}

// ---------- Step 1: company profile ----------

export function CompanyStep({
  initialAbout,
  initialBillingEmail,
}: {
  initialAbout: string;
  initialBillingEmail: string;
}) {
  const [state, action, pending] = useActionState(saveCompanyDetails, null);
  return (
    <form action={action} className="space-y-4 rounded-lg border p-4" data-testid="step-company">
      <h2 className="font-medium">Step 1 · Company details</h2>
      <ErrorText state={state} />
      <div>
        <label className={labelClass} htmlFor="about">About the company</label>
        <textarea
          id="about"
          name="about"
          required
          rows={3}
          defaultValue={initialAbout}
          className={inputClass}
          data-testid="company-about"
          placeholder="What you make, capacity, and what makes you a great partner."
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="billingEmail">Billing email (optional)</label>
        <input
          id="billingEmail"
          name="billingEmail"
          type="email"
          defaultValue={initialBillingEmail}
          className={inputClass}
          data-testid="company-billing-email"
        />
      </div>
      <SubmitButton pending={pending} testid="submit-company">Save and continue</SubmitButton>
    </form>
  );
}

// ---------- Step 2: plants ----------

interface PlantRow {
  id: string;
  name: string;
  city: string;
  country: string;
}

export function PlantsStep({ plants }: { plants: PlantRow[] }) {
  const [state, action, pending] = useActionState(upsertPlant, null);
  return (
    <form action={action} className="space-y-4 rounded-lg border p-4" data-testid="step-plants">
      <h2 className="font-medium">Step 2 · Plants & locations</h2>
      <ErrorText state={state} />
      {plants.length > 0 ? (
        <ul className="text-sm text-neutral-700" data-testid="plant-list">
          {plants.map((p) => (
            <li key={p.id}>
              {p.name} — {p.city}, {p.country}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="plantName">Plant name</label>
          <input id="plantName" name="name" required className={inputClass} data-testid="plant-name" />
        </div>
        <div>
          <label className={labelClass} htmlFor="plantCity">City</label>
          <input id="plantCity" name="city" required className={inputClass} data-testid="plant-city" />
        </div>
        <div>
          <label className={labelClass} htmlFor="plantCountry">Country</label>
          <input id="plantCountry" name="country" required className={inputClass} data-testid="plant-country" />
        </div>
        <div>
          <label className={labelClass} htmlFor="plantState">State/region (optional)</label>
          <input id="plantState" name="state" className={inputClass} data-testid="plant-state" />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isPrimary" data-testid="plant-primary" /> Primary plant
      </label>
      <SubmitButton pending={pending} testid="submit-plant">Add plant</SubmitButton>
    </form>
  );
}

// ---------- Step 3: certifications + document upload ----------

interface CertificationRow {
  id: string;
  type: string;
  number: string;
  evidenceFileId: string | null;
}

export function CertificationsStep({ certifications }: { certifications: CertificationRow[] }) {
  const [state, action, pending] = useActionState(upsertCertification, null);
  return (
    <form action={action} className="space-y-4 rounded-lg border p-4" data-testid="step-certifications">
      <h2 className="font-medium">Step 3 · Certifications</h2>
      <ErrorText state={state} />
      {certifications.length > 0 ? (
        <ul className="text-sm text-neutral-700" data-testid="certification-list">
          {certifications.map((c) => (
            <li key={c.id}>
              {c.type} #{c.number} {c.evidenceFileId ? "· document attached" : "· no document"}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor="certType">Type (e.g. SQF, BRCGS)</label>
          <input id="certType" name="type" required className={inputClass} data-testid="certification-type" />
        </div>
        <div>
          <label className={labelClass} htmlFor="certNumber">Certificate number</label>
          <input id="certNumber" name="number" required className={inputClass} data-testid="certification-number" />
        </div>
        <div>
          <label className={labelClass} htmlFor="certIssued">Issued at (optional)</label>
          <input id="certIssued" name="issuedAt" type="date" className={inputClass} data-testid="certification-issued" />
        </div>
        <div>
          <label className={labelClass} htmlFor="certExpires">Expires at</label>
          <input
            id="certExpires"
            name="expiresAt"
            type="date"
            required
            className={inputClass}
            data-testid="certification-expires"
          />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="certFile">Evidence document (PDF/image, optional)</label>
        <input id="certFile" name="file" type="file" className="block text-sm" data-testid="certification-file" />
      </div>
      <SubmitButton pending={pending} testid="submit-certification">Add certification</SubmitButton>
    </form>
  );
}

// ---------- Step 4: equipment & capabilities ----------

interface EquipmentRow {
  id: string;
  kind: string;
  make: string | null;
  model: string | null;
}

interface CapabilityRow {
  id: string;
  name: string;
}

const KINDS = ["FILLER", "SEALER", "CAPPER", "DECORATOR", "LABELER", "OTHER"] as const;

export function EquipmentStep({
  equipment,
  capabilities,
}: {
  equipment: EquipmentRow[];
  capabilities: CapabilityRow[];
}) {
  const [equipmentState, equipmentAction, equipmentPending] = useActionState(upsertEquipment, null);
  const [capabilityState, capabilityAction, capabilityPending] = useActionState(addCapability, null);
  return (
    <div className="space-y-4" data-testid="step-equipment">
      <form action={equipmentAction} className="space-y-4 rounded-lg border p-4">
        <h2 className="font-medium">Step 4 · Equipment</h2>
        <ErrorText state={equipmentState} />
        {equipment.length > 0 ? (
          <ul className="text-sm text-neutral-700" data-testid="equipment-list">
            {equipment.map((e) => (
              <li key={e.id}>
                {e.kind} {e.make ?? ""} {e.model ?? ""}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass} htmlFor="eqKind">Kind</label>
            <select id="eqKind" name="kind" className={inputClass} data-testid="equipment-kind">
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="eqMake">Make</label>
            <input id="eqMake" name="make" className={inputClass} data-testid="equipment-make" />
          </div>
          <div>
            <label className={labelClass} htmlFor="eqModel">Model</label>
            <input id="eqModel" name="model" className={inputClass} data-testid="equipment-model" />
          </div>
        </div>
        <SubmitButton pending={equipmentPending} testid="submit-equipment">Add equipment</SubmitButton>
      </form>

      <form action={capabilityAction} className="space-y-4 rounded-lg border p-4">
        <h2 className="font-medium">Capabilities</h2>
        <ErrorText state={capabilityState} />
        {capabilities.length > 0 ? (
          <ul className="text-sm text-neutral-700" data-testid="capability-list">
            {capabilities.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ul>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="capName">Capability</label>
            <input id="capName" name="name" required className={inputClass} data-testid="capability-name" />
          </div>
          <div>
            <label className={labelClass} htmlFor="capDetail">Detail (optional)</label>
            <input id="capDetail" name="detail" className={inputClass} data-testid="capability-detail" />
          </div>
        </div>
        <SubmitButton pending={capabilityPending} testid="submit-capability">Add capability</SubmitButton>
      </form>
    </div>
  );
}

// ---------- Step 5: MOQ & payment terms ----------

const TERMS = ["FULL_PREPAY", "DEPOSIT_50_50", "NET_15", "NET_30", "NET_45", "NET_60"] as const;

export function TermsStep({
  initialMinOrderDollars,
  initialPaymentTerms,
}: {
  initialMinOrderDollars: string;
  initialPaymentTerms: string;
}) {
  const [state, action, pending] = useActionState(saveCommercialTerms, null);
  return (
    <form action={action} className="space-y-4 rounded-lg border p-4" data-testid="step-terms">
      <h2 className="font-medium">Step 5 · MOQ & payment terms</h2>
      <ErrorText state={state} />
      <div>
        <label className={labelClass} htmlFor="moq">Minimum order value (USD)</label>
        <input
          id="moq"
          name="minOrderValueDollars"
          type="number"
          min="0.01"
          step="0.01"
          required
          defaultValue={initialMinOrderDollars}
          className={inputClass}
          data-testid="terms-min-order"
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="terms">Payment terms</label>
        <select
          id="terms"
          name="paymentTerms"
          defaultValue={initialPaymentTerms}
          className={inputClass}
          data-testid="terms-select"
        >
          {TERMS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <SubmitButton pending={pending} testid="submit-terms">Save and continue</SubmitButton>
    </form>
  );
}

// ---------- Step 6: Stripe Connect + submit for review ----------

export function PaymentsStep({ linkedAccountId }: { linkedAccountId: string | null }) {
  const [linkState, linkAction, linkPending] = useActionState(linkStripeConnect, null);
  const [submitState, submitAction, submitPending] = useActionState(submitForReview, null);
  return (
    <div className="space-y-4" data-testid="step-payments">
      <form action={linkAction} className="space-y-4 rounded-lg border p-4">
        <h2 className="font-medium">Step 6 · Stripe Connect account</h2>
        <ErrorText state={linkState} />
        {linkedAccountId ? (
          <p className="text-sm text-neutral-700" data-testid="payments-linked">
            Connected account <code>{linkedAccountId}</code> is linked.
          </p>
        ) : (
          <p className="text-sm text-neutral-600">
            Link a Stripe Connect account to receive payouts. (Mock provider — no keys needed.)
          </p>
        )}
        <SubmitButton pending={linkPending} testid="submit-payments">
          {linkedAccountId ? "Re-link account" : "Link Stripe Connect account"}
        </SubmitButton>
      </form>

      {linkedAccountId ? (
        <form action={submitAction} className="space-y-4 rounded-lg border p-4">
          <h2 className="font-medium">Submit for review</h2>
          <ErrorText state={submitState} />
          <p className="text-sm text-neutral-600">
            Submitting locks this profile for editing and places it in the Aekovera
            verification queue. Your profile stays invisible to buyers until it is
            approved.
          </p>
          <SubmitButton pending={submitPending} testid="submit-for-review">Submit for review</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}

// ---------- Post-submission state ----------

export function SubmittedPanel() {
  return (
    <div className="rounded-lg border p-4" data-testid="wizard-submitted">
      <h2 className="font-medium">Submitted for review</h2>
      <p className="mt-2 text-sm text-neutral-600">
        Your profile is in the Aekovera verification queue. It is not publicly visible
        until a reviewer approves it. You can no longer edit the submitted profile.
      </p>
    </div>
  );
}
