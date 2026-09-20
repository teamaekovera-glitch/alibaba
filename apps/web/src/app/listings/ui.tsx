"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { ListingActionState, ImportActionState } from "./actions";
import {
  confirmImage,
  confirmSpecSheet,
  createListing,
  applySpecSuggestions,
  importListings,
  transitionListing,
  updateListingDraft,
  uploadImage,
  uploadSpecSheet,
} from "./actions";

/**
 * Supplier listing-management console. Server pages pass serializable props
 * only — attribute definitions, the import column contract, and available
 * transitions are computed on the server so no package barrel (and none of
 * its Prisma transitives) reaches the client bundle.
 */

const inputClass = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-xs font-medium text-neutral-600";
const sectionClass = "rounded-lg border border-neutral-200 bg-white p-5";

function ErrorText({ state }: { state: ListingActionState | ImportActionState }) {
  if (!state || !("error" in state)) {
    return null;
  }
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="form-error">
      {state.error}
    </p>
  );
}

function OkText({ state }: { state: ListingActionState | ImportActionState }) {
  if (!state || !("ok" in state) || !state.ok) {
    return null;
  }
  const message = "message" in state ? state.message : undefined;
  return (
    <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" data-testid="form-ok">
      {message ?? "Saved."}
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

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-neutral-100 text-neutral-700",
  PENDING_REVIEW: "bg-amber-100 text-amber-800",
  LIVE: "bg-green-100 text-green-800",
  PAUSED: "bg-blue-100 text-blue-800",
  REJECTED: "bg-red-100 text-red-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      data-testid={`status-${status}`}
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? "bg-neutral-100 text-neutral-700"}`}
    >
      {status}
    </span>
  );
}

// ---------- shared form fields ----------

export interface AttributeDef {
  key: string;
  label: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "multiEnum" | "dimensions";
  required: boolean;
  options?: string[];
  unit?: string;
}

interface AttributeValue {
  [key: string]: unknown;
}

function AttributeFields({ defs, initial }: { defs: AttributeDef[]; initial: AttributeValue }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {defs.map((def) => {
        const value = initial[def.key];
        const name = `attr_${def.key}`;
        if (def.type === "multiEnum") {
          const chosen = Array.isArray(value) ? value.map(String) : [];
          return (
            <div key={def.key} className="sm:col-span-2">
              <span className={labelClass}>
                {def.label}
                {def.required ? " *" : ""}
              </span>
              <div className="mt-1 flex flex-wrap gap-3">
                {(def.options ?? []).map((option) => (
                  <label key={option} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name={name} value={option} defaultChecked={chosen.includes(option)} />
                    {option}
                  </label>
                ))}
              </div>
            </div>
          );
        }
        if (def.type === "boolean") {
          return (
            <label key={def.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={name} defaultChecked={value === true} />
              {def.label}
              {def.required ? " *" : ""}
            </label>
          );
        }
        if (def.type === "dimensions") {
          const dims = (value ?? {}) as { lengthMm?: unknown; widthMm?: unknown; heightMm?: unknown };
          return (
            <div key={def.key}>
              <span className={labelClass}>
                {def.label} (mm){def.required ? " *" : ""}
              </span>
              <div className="mt-1 grid grid-cols-3 gap-2">
                <input className={inputClass} name={`${name}_l`} type="number" step="any" placeholder="L" defaultValue={dims.lengthMm === undefined || dims.lengthMm === null ? "" : String(dims.lengthMm)} />
                <input className={inputClass} name={`${name}_w`} type="number" step="any" placeholder="W" defaultValue={dims.widthMm === undefined || dims.widthMm === null ? "" : String(dims.widthMm)} />
                <input className={inputClass} name={`${name}_h`} type="number" step="any" placeholder="H" defaultValue={dims.heightMm === undefined || dims.heightMm === null ? "" : String(dims.heightMm)} />
              </div>
            </div>
          );
        }
        if (def.type === "enum") {
          return (
            <div key={def.key}>
              <label className={labelClass}>
                {def.label}
                {def.required ? " *" : ""}
              </label>
              <select className={inputClass} name={name} defaultValue={typeof value === "string" ? value : ""}>
                <option value="">—</option>
                {(def.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        const isNumber = def.type === "number" || def.type === "integer";
        return (
          <div key={def.key}>
            <label className={labelClass}>
              {def.label}
              {def.unit ? ` (${def.unit})` : ""}
              {def.required ? " *" : ""}
            </label>
            <input
              className={inputClass}
              name={name}
              type={isNumber ? "number" : "text"}
              step="any"
              defaultValue={value === undefined || value === null ? "" : String(value)}
            />
          </div>
        );
      })}
    </div>
  );
}

interface LadderRow {
  minQty: number;
  unitPriceCents: number;
}

interface LeadRow {
  qtyMin: number;
  qtyMax: number | null;
  productionDays: number;
}

function NumberCell({
  name,
  value,
  placeholder,
}: {
  name: string;
  value: number | null | undefined;
  placeholder: string;
}) {
  return (
    <input
      className={inputClass}
      name={name}
      type="number"
      step="1"
      placeholder={placeholder}
      defaultValue={value === null || value === undefined ? "" : String(value)}
    />
  );
}

export function LadderAndVariantFields({
  moqTiers,
  leadTimeRules,
  variants,
}: {
  moqTiers: LadderRow[];
  leadTimeRules: LeadRow[];
  variants: { sku: string; unitPriceCents: number | null }[];
}) {
  return (
    <>
      <div>
        <h3 className="text-sm font-semibold text-neutral-800">MOQ price ladder</h3>
        <p className="mb-2 text-xs text-neutral-500">Tier 1 is required; further tiers optional. Later tiers need lower unit prices.</p>
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="contents">
              <NumberCell name={`moq_minQty_${i + 1}`} value={moqTiers[i]?.minQty} placeholder={`Tier ${i + 1} min qty`} />
              <NumberCell name={`moq_price_${i + 1}`} value={moqTiers[i]?.unitPriceCents} placeholder={`Tier ${i + 1} unit price (cents)`} />
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-neutral-800">Lead-time bands</h3>
        <p className="mb-2 text-xs text-neutral-500">Band 1 is required. Leave max quantity empty for an open-ended band.</p>
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="contents">
              <NumberCell name={`lead_min_${i + 1}`} value={leadTimeRules[i]?.qtyMin} placeholder={`Band ${i + 1} min qty`} />
              <NumberCell name={`lead_max_${i + 1}`} value={leadTimeRules[i]?.qtyMax} placeholder="max (optional)" />
              <NumberCell name={`lead_days_${i + 1}`} value={leadTimeRules[i]?.productionDays} placeholder="days" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-neutral-800">Variants (optional)</h3>
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="contents">
              <input className={inputClass} name={`variant_sku_${i + 1}`} placeholder={`Variant ${i + 1} SKU`} defaultValue={variants[i]?.sku ?? ""} />
              <NumberCell name={`variant_price_${i + 1}`} value={variants[i]?.unitPriceCents} placeholder="unit price (cents)" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------- create ----------

export interface CategoryOption {
  slug: string;
  name: string;
  attributes: AttributeDef[];
}

export function CreateListingForm({ categories }: { categories: CategoryOption[] }) {
  const [state, action, pending] = useActionState(createListing, null);
  const [slug, setSlug] = useState(categories[0]?.slug ?? "");
  const chosen = categories.find((category) => category.slug === slug) ?? categories[0];

  return (
    <form action={action} className="flex flex-col gap-5">
      <ErrorText state={state} />
      <OkText state={state} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Title *</label>
          <input className={inputClass} name="title" data-testid="listing-title" required minLength={3} maxLength={160} />
        </div>
        <div>
          <label className={labelClass}>Category *</label>
          <select
            className={inputClass}
            name="categorySlug"
            data-testid="listing-category"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          >
            {categories.map((category) => (
              <option key={category.slug} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className={labelClass}>Description</label>
        <textarea className={inputClass} name="description" rows={3} maxLength={5000} />
      </div>
      {chosen ? <AttributeFields key={chosen.slug} defs={chosen.attributes} initial={{}} /> : null}
      <LadderAndVariantFields moqTiers={[]} leadTimeRules={[]} variants={[]} />
      <div>
        <label className={labelClass}>Stock level</label>
        <select className={inputClass} name="stockLevel" defaultValue="">
          <option value="">—</option>
          <option value="OUT_OF_STOCK">OUT_OF_STOCK</option>
          <option value="LOW">LOW</option>
          <option value="IN_STOCK">IN_STOCK</option>
          <option value="MADE_TO_ORDER">MADE_TO_ORDER</option>
        </select>
      </div>
      <div>
        <label className={labelClass}>Capacity (units/week)</label>
        <input className={inputClass} name="capacityUnitsPerWeek" type="number" min={0} />
      </div>
      <Submit pending={pending} testid="listing-create-submit">
        Create draft
      </Submit>
    </form>
  );
}

// ---------- transitions ----------

const TRANSITION_LABELS: Record<string, string> = {
  submit: "Submit for review",
  publish: "Publish",
  reject: "Reject",
  unpublish: "Unpublish",
  republish: "Republish",
  resumeEditing: "Reopen for editing",
  withdraw: "Withdraw from review",
  revise: "Back to draft",
};

export function TransitionBar({ listingId, actions }: { listingId: string; actions: string[] }) {
  const [state, action, pending] = useActionState(transitionListing, null);
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="listingId" value={listingId} />
        {actions.map((transition) => (
          <button
            key={transition}
            type="submit"
            name="transition"
            value={transition}
            disabled={pending}
            data-testid={`transition-${transition}`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
          >
            {TRANSITION_LABELS[transition] ?? transition}
          </button>
        ))}
      </form>
      {actions.includes("reject") ? (
        <input className={`${inputClass} max-w-sm`} name="reason" placeholder="Rejection reason (used when rejecting)" />
      ) : null}
      <ErrorText state={state} />
      <OkText state={state} />
    </div>
  );
}

// ---------- editor ----------

interface SpecSheetView {
  id: string;
  title: string;
  extractionStatus: string;
  suggestions: { key: string; value: unknown; confidence: string; evidence: string }[];
  reasoningModel: string | null;
}

interface ImageView {
  position: number;
  url: string;
  alt: string | null;
  suggestedTags: string[] | null;
  suggestedAlt: string | null;
  suggestionStatus: string | null;
}

export function ListingEditor({
  listingId,
  categorySlug,
  attributeDefs,
  initial,
  moqTiers,
  leadTimeRules,
  variants,
  images,
  specSheets,
}: {
  listingId: string;
  categorySlug: string;
  attributeDefs: AttributeDef[];
  initial: {
    title: string;
    description: string | null;
    attributes: AttributeValue;
    stockLevel: string | null;
    capacityUnitsPerWeek: number | null;
  };
  moqTiers: LadderRow[];
  leadTimeRules: LeadRow[];
  variants: { sku: string; unitPriceCents: number | null }[];
  images: ImageView[];
  specSheets: SpecSheetView[];
}) {
  const [state, action, pending] = useActionState(updateListingDraft, null);

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClass}>
        <h2 className="mb-3 text-base font-semibold text-neutral-900">Listing details</h2>
        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="categorySlug" value={categorySlug} />
          <ErrorText state={state} />
          <OkText state={state} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Title *</label>
              <input className={inputClass} name="title" data-testid="listing-title" defaultValue={initial.title} required minLength={3} maxLength={160} />
            </div>
            <div>
              <label className={labelClass}>Stock level</label>
              <select className={inputClass} name="stockLevel" defaultValue={initial.stockLevel ?? ""}>
                <option value="">—</option>
                <option value="OUT_OF_STOCK">OUT_OF_STOCK</option>
                <option value="LOW">LOW</option>
                <option value="IN_STOCK">IN_STOCK</option>
                <option value="MADE_TO_ORDER">MADE_TO_ORDER</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <textarea className={inputClass} name="description" rows={3} maxLength={5000} defaultValue={initial.description ?? ""} />
          </div>
          <AttributeFields defs={attributeDefs} initial={initial.attributes} />
          <LadderAndVariantFields moqTiers={moqTiers} leadTimeRules={leadTimeRules} variants={variants} />
          <div>
            <label className={labelClass}>Capacity (units/week)</label>
            <input className={inputClass} name="capacityUnitsPerWeek" type="number" min={0} defaultValue={initial.capacityUnitsPerWeek ?? ""} />
          </div>
          <Submit pending={pending} testid="listing-save">
            Save draft
          </Submit>
        </form>
      </section>

      {/* Spec sheets + extraction review */}
      <section className={sectionClass}>
        <h2 className="mb-3 text-base font-semibold text-neutral-900">Spec sheets &amp; AI extraction</h2>
        <SpecSheetPanel listingId={listingId} categorySlug={categorySlug} sheets={specSheets} />
      </section>

      {/* Images + vision review */}
      <section className={sectionClass}>
        <h2 className="mb-3 text-base font-semibold text-neutral-900">Images</h2>
        <ImagesPanel listingId={listingId} images={images} />
      </section>
    </div>
  );
}

function SpecSheetPanel({
  listingId,
  categorySlug,
  sheets,
}: {
  listingId: string;
  categorySlug: string;
  sheets: SpecSheetView[];
}) {
  const [uploadState, uploadAction, uploading] = useActionState(uploadSpecSheet, null);
  const [applyState, applyAction, applying] = useActionState(applySpecSuggestions, null);
  const [confirmState, confirmAction, confirming] = useActionState(confirmSpecSheet, null);

  return (
    <div className="flex flex-col gap-4">
      <form action={uploadAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="categorySlug" value={categorySlug} />
        <input type="file" name="specSheet" data-testid="spec-sheet-input" accept=".txt,.md,.csv,.json" className="text-sm" />
        <Submit pending={uploading} testid="spec-sheet-upload">
          Upload &amp; extract
        </Submit>
        <ErrorText state={uploadState} />
        <OkText state={uploadState} />
      </form>

      {sheets.length === 0 ? (
        <p className="text-sm text-neutral-500">No spec sheets uploaded yet.</p>
      ) : (
        sheets.map((sheet) => (
          <div key={sheet.id} className="rounded-md border border-neutral-200 p-4" data-testid={`spec-sheet-${sheet.extractionStatus}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-neutral-800">{sheet.title}</span>
              <StatusBadge status={sheet.extractionStatus} />
            </div>
            {sheet.extractionStatus === "EXTRACTED" ? (
              <>
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-neutral-500">
                      <th className="py-1">Field</th>
                      <th className="py-1">Suggested value</th>
                      <th className="py-1">Confidence</th>
                      <th className="py-1">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.suggestions.map((suggestion) => (
                      <tr key={suggestion.key} className="border-t border-neutral-100">
                        <td className="py-1 font-mono text-xs">{suggestion.key}</td>
                        <td className="py-1">{String(suggestion.value)}</td>
                        <td className="py-1">
                          <span
                            className={
                              suggestion.confidence === "high"
                                ? "text-green-700"
                                : suggestion.confidence === "medium"
                                  ? "text-amber-700"
                                  : "text-red-700"
                            }
                          >
                            {suggestion.confidence}
                          </span>
                        </td>
                        <td className="py-1 text-xs text-neutral-500">{suggestion.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex flex-wrap gap-2">
                  <form action={applyAction}>
                    <input type="hidden" name="listingId" value={listingId} />
                    <input type="hidden" name="specSheetId" value={sheet.id} />
                    <Submit pending={applying} testid="spec-apply">
                      Apply to draft
                    </Submit>
                  </form>
                  <form action={confirmAction}>
                    <input type="hidden" name="listingId" value={listingId} />
                    <input type="hidden" name="specSheetId" value={sheet.id} />
                    <Submit pending={confirming} testid="spec-confirm">
                      Confirm extraction
                    </Submit>
                  </form>
                </div>
                <ErrorText state={applyState} />
                <OkText state={applyState} />
                <ErrorText state={confirmState} />
              </>
            ) : null}
            {sheet.extractionStatus === "CONFIRMED" ? (
              <p className="mt-2 text-xs text-neutral-500">
                Extraction confirmed by a human — publish gate cleared for this sheet
                {sheet.reasoningModel ? ` (extracted via ${sheet.reasoningModel})` : ""}.
              </p>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function ImagesPanel({ listingId, images }: { listingId: string; images: ImageView[] }) {
  const [uploadState, uploadAction, uploading] = useActionState(uploadImage, null);
  const [confirmState, confirmAction, confirming] = useActionState(confirmImage, null);

  return (
    <div className="flex flex-col gap-4">
      <form action={uploadAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="listingId" value={listingId} />
        <input type="file" name="image" data-testid="image-input" accept="image/*" className="text-sm" />
        <Submit pending={uploading} testid="image-upload">
          Upload image
        </Submit>
        <ErrorText state={uploadState} />
        <OkText state={uploadState} />
      </form>

      {images.length === 0 ? (
        <p className="text-sm text-neutral-500">No images uploaded yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {images.map((image) => (
            <li key={image.position} className="rounded-md border border-neutral-200 p-3 text-sm" data-testid={`image-${image.suggestionStatus ?? "confirmed"}`}>
              <div className="font-mono text-xs text-neutral-500">{image.url}</div>
              {image.suggestionStatus === "pending" ? (
                <div className="mt-2 flex flex-col gap-2">
                  <p className="text-xs text-neutral-600">
                    Suggested tags: {image.suggestedTags?.join(", ")}
                    <br />
                    {image.suggestedAlt}
                  </p>
                  <form action={confirmAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="listingId" value={listingId} />
                    <input type="hidden" name="position" value={image.position} />
                    <input className={`${inputClass} max-w-xs`} name="alt" placeholder="Alt text (override)" defaultValue={image.suggestedAlt ?? ""} />
                    <Submit pending={confirming} testid={`image-confirm-${image.position}`}>
                      Confirm tags
                    </Submit>
                  </form>
                  <ErrorText state={confirmState} />
                </div>
              ) : (
                <p className="mt-1 text-xs text-neutral-600">Alt: {image.alt ?? "—"}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- bulk import ----------

export interface ImportColumnView {
  name: string;
  required: boolean;
  description: string;
  example: string;
}

export function ImportForm({ columns }: { columns: ImportColumnView[] }) {
  const [state, action, pending] = useActionState(importListings, null);
  const reportReady = state !== null && "ok" in state && state.ok === true;

  function downloadReport() {
    if (!state || !("ok" in state) || !state.ok) {
      return;
    }
    const blob = new Blob([state.errorCsv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "import-errors.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-5">
      <form action={action} className="flex flex-wrap items-center gap-3" data-testid="import-form">
        <input type="file" name="csvFile" accept=".csv,text/csv" data-testid="import-file" className="text-sm" />
        <Submit pending={pending} testid="import-submit">
          Import CSV
        </Submit>
      </form>
      <ErrorText state={state} />
      <OkText state={state} />
      {reportReady ? (
        <button
          type="button"
          onClick={downloadReport}
          data-testid="import-report-download"
          className="w-fit rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Download error report
        </button>
      ) : null}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-800">Column contract</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="py-1">Column</th>
              <th className="py-1">Required</th>
              <th className="py-1">Description</th>
              <th className="py-1">Example</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.name} className="border-t border-neutral-100">
                <td className="py-1 font-mono text-xs">{column.name}</td>
                <td className="py-1">{column.required ? "yes" : ""}</td>
                <td className="py-1 text-neutral-600">{column.description}</td>
                <td className="py-1 font-mono text-xs text-neutral-500">{column.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-neutral-500">
          Unknown columns are ignored. Each row imports atomically — a malformed row never partially writes and never
          blocks the other rows.
        </p>
      </div>
    </div>
  );
}

export function ConsoleLink({ href, children, testid }: { href: string; children: React.ReactNode; testid?: string }) {
  return (
    <Link href={href} data-testid={testid} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50">
      {children}
    </Link>
  );
}
