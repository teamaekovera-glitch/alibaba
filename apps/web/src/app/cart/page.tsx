import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatCents } from "@/lib/money";
import { tradeRepositories } from "@/lib/trade";
import { AcceptQuoteButton, RemoveFromCartButton } from "../rfq/forms";

/**
 * Quote cart: one cart per buyer org, sorted by normalized landed cost, with
 * the spec's side-by-side comparison (unit x qty + amortized tooling/plates +
 * freight + duty). Accepting a quote awards the RFQ and creates the
 * pre-payment order.
 */
export default async function CartPage() {
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const trade = await tradeRepositories();
  if (!trade) {
    redirect("/sign-in");
  }

  const items = await trade.cart.listCart();

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold" data-testid="cart-title">Quote cart</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Quotes from different suppliers, normalized to landed cost: unit price ×
        quantity, tooling and plate amortization, freight estimate, and duty
        proxy — all integer cents. Sorted cheapest landed first.
      </p>

      {items.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-600" data-testid="cart-empty">
          Your cart is empty. Add quotes from an RFQ detail page.
        </p>
      ) : (
        <table className="mt-6 w-full text-sm" data-testid="cart-table">
          <thead>
            <tr className="border-b text-left text-neutral-600">
              <th className="py-2">Supplier</th>
              <th className="py-2">Qty</th>
              <th className="py-2">Unit</th>
              <th className="py-2">Landed /unit</th>
              <th className="py-2">Landed total</th>
              <th className="py-2">Lead</th>
              <th className="py-2">Valid until</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map(({ cartItemId, quote, landedCost }) => (
              <tr key={cartItemId} className="border-b" data-testid={`cart-row-${quote.id}`}>
                <td className="py-2">
                  <Link className="underline" href={`/rfq/${quote.rfqId}`}>
                    {quote.org.name}
                  </Link>
                </td>
                <td className="py-2">{quote.quantity.toLocaleString("en-US")}</td>
                <td className="py-2">{formatCents(quote.unitPriceCents)}</td>
                <td className="py-2" data-testid={`cart-unit-landed-${quote.id}`}>
                  {formatCents(landedCost.unitLandedCents)}
                </td>
                <td className="py-2 font-medium" data-testid={`cart-total-${quote.id}`}>
                  {formatCents(landedCost.totalCents)}
                </td>
                <td className="py-2">{quote.leadTimeDays}d</td>
                <td className="py-2">{quote.validUntil.toISOString().slice(0, 10)}</td>
                <td className="py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <AcceptQuoteButton quoteId={quote.id} />
                    <RemoveFromCartButton cartItemId={cartItemId} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {items.length > 0 ? (
        <details className="mt-6 rounded-lg border border-neutral-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Landed-cost breakdown</summary>
          <ul className="mt-3 space-y-3" data-testid="cart-breakdown">
            {items.map(({ cartItemId, quote, landedCost }) => (
              <li key={cartItemId} className="text-sm" data-testid={`breakdown-${quote.id}`}>
                <strong>{quote.org.name}</strong> — total {formatCents(landedCost.totalCents)}:
                <ul className="mt-1 ml-4 text-neutral-700">
                  {landedCost.breakdown.map((entry) => (
                    <li key={`${cartItemId}-${entry.key}`}>
                      {entry.key}: {formatCents(entry.cents)}
                      {entry.note ? ` (${entry.note})` : ""}
                    </li>
                  ))}
                  <li>one-time subtotal: {formatCents(landedCost.oneTimeCents)}</li>
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-8 text-sm">
        <Link className="underline" href="/rfq">← RFQ dashboard</Link>
      </p>
    </main>
  );
}
