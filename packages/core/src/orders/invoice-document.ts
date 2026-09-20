/**
 * Invoice document rendering (spec: "Invoices" — integer cents, generated
 * per schedule/milestone, downloadable through the storage mock). Pure and
 * deterministic: the same order data always renders the same document, so
 * re-running issuance cannot fork the file content.
 */
import type { OrderLine, Prisma } from "@packsource/db";

/** An invoice line as rendered: description + integer-cent amount. */
export interface InvoiceLine {
  description: string;
  amountCents: number;
}

/** Everything an invoice document needs, all of it already validated upstream. */
export interface InvoiceDocumentInput {
  number: string;
  kind: "PRO_FORMA" | "COMMERCIAL" | "CREDIT_NOTE";
  orderId: string;
  buyerOrgId: string;
  supplierOrgId: string;
  issuedAt: Date;
  dueAt: Date;
  paymentSchedule: "FULL_PREPAY" | "DEPOSIT_30_70" | "NET_30";
  orderLines: Pick<OrderLine, "description" | "quantity" | "unitPriceCents" | "totalCents">[];
  surcharges: { toolingCents: number; plateChargesCents: number; freightCents: number };
  totalCents: number;
  /** Issuance note (e.g. "Net-30 receivable", "Balance due before shipment"). */
  note?: string;
  /** Present on credit notes: the refunded amount and why. */
  credit?: { amountCents: number; reason: string };
}

/** Human label for a schedule value (kept in sync with the schema enums). */
function scheduleLabel(schedule: InvoiceDocumentInput["paymentSchedule"]): string {
  switch (schedule) {
    case "FULL_PREPAY":
      return "Full prepayment";
    case "DEPOSIT_30_70":
      return "30% deposit / 70% before shipment";
    case "NET_30":
      return "Net 30 days from shipment";
  }
}

/** Exactly N dollars from integer cents — no float arithmetic anywhere. */
function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Render the invoice as text (the storage mock stores UTF-8 documents; the
 * signed download serves this content). Deterministic ordering: order lines
 * in the order given, surcharge block in schema order, totals last.
 */
export function renderInvoiceDocument(input: InvoiceDocumentInput): string {
  const lines: string[] = [];
  const kindLabel =
    input.kind === "PRO_FORMA" ? "PRO FORMA INVOICE" : input.kind === "COMMERCIAL" ? "COMMERCIAL INVOICE" : "CREDIT NOTE";

  lines.push(`PackSource — ${kindLabel}`);
  lines.push(`Invoice ${input.number}`);
  lines.push(`Order:    ${input.orderId}`);
  lines.push(`Buyer:    org ${input.buyerOrgId}`);
  lines.push(`Supplier: org ${input.supplierOrgId}`);
  lines.push(`Issued:   ${isoDate(input.issuedAt)}`);
  lines.push(`Due:      ${isoDate(input.dueAt)}`);
  lines.push(`Terms:    ${scheduleLabel(input.paymentSchedule)}`);
  lines.push("");

  lines.push("Lines:");
  for (const line of input.orderLines) {
    lines.push(
      `  - ${line.description} x${line.quantity} @ ${usd(line.unitPriceCents)} = ${usd(line.totalCents)}`,
    );
  }
  if (input.surcharges.toolingCents > 0) {
    lines.push(`  - Tooling: ${usd(input.surcharges.toolingCents)}`);
  }
  if (input.surcharges.plateChargesCents > 0) {
    lines.push(`  - Plate charges: ${usd(input.surcharges.plateChargesCents)}`);
  }
  if (input.surcharges.freightCents > 0) {
    lines.push(`  - Freight: ${usd(input.surcharges.freightCents)}`);
  }
  lines.push("");

  if (input.credit) {
    lines.push(`Credit issued: ${usd(input.credit.amountCents)}`);
    lines.push(`Reason: ${input.credit.reason}`);
    lines.push(`Credit note total: ${usd(-input.credit.amountCents)}`);
  } else {
    lines.push(`Total due: ${usd(input.totalCents)}`);
  }
  if (input.note) {
    lines.push(`Note: ${input.note}`);
  }
  lines.push("");
  lines.push("All amounts in US dollars, computed in integer cents.");
  lines.push(`Document generated ${input.issuedAt.toISOString()} by PackSource (mock storage).`);
  lines.push("");
  return lines.join("\n");
}

/** Surcharge triple from an order row, for building renderer inputs. */
export function surchargesFromOrder(order: {
  toolingCents: number;
  plateChargesCents: number;
  freightCents: number;
}): InvoiceDocumentInput["surcharges"] {
  return {
    toolingCents: order.toolingCents,
    plateChargesCents: order.plateChargesCents,
    freightCents: order.freightCents,
  };
}

/** Type guard narrowing the invoice kind for document payloads. */
export type InvoiceKind = InvoiceDocumentInput["kind"];

/** Convenience: build input from a Prisma order include shape. */
export type InvoiceOrderLike = Prisma.OrderGetPayload<{ include: { orderLines: true } }>;
