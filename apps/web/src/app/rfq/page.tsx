import { PermissionDeniedError } from "@packsource/core";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { tradeRepositories } from "@/lib/trade";
import { CreateRfqForm, CancelRfqButton, SendRfqButton } from "./forms";

/**
 * Buyer RFQ dashboard: create RFQs and track the pipeline. Suppliers see a
 * pointer to their inbox — RFQ creation is a buyer action.
 */
export default async function RfqDashboardPage() {
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const trade = await tradeRepositories();
  if (!trade) {
    redirect("/sign-in");
  }

  let rfqs;
  try {
    rfqs = await trade.rfq.listMine();
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return (
        <main className="mx-auto max-w-lg px-4 py-16 text-center" data-testid="not-buyer">
          <h1 className="text-xl font-semibold">RFQ dashboard</h1>
          <p className="mt-2 text-sm text-neutral-600">
            RFQs are created by buyer accounts. Suppliers can see incoming quote
            requests in their inbox.
          </p>
          <Link className="mt-4 inline-block text-sm underline" href="/rfq/inbox" data-testid="go-to-inbox">
            Go to supplier inbox
          </Link>
        </main>
      );
    }
    throw error;
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" data-testid="rfq-dashboard-title">RFQs</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/rfq/inbox" data-testid="nav-inbox">Supplier inbox</Link>
          <Link className="underline" href="/cart" data-testid="nav-cart">Quote cart</Link>
          <Link className="underline" href="/orders" data-testid="nav-orders">Orders</Link>
        </nav>
      </header>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Your RFQs</h2>
        {rfqs.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600" data-testid="rfq-empty">
            No RFQs yet — create your first one below.
          </p>
        ) : (
          <table className="mt-3 w-full text-sm" data-testid="rfq-table">
            <thead>
              <tr className="border-b text-left text-neutral-600">
                <th className="py-2">Title</th>
                <th className="py-2">Mode</th>
                <th className="py-2">Status</th>
                <th className="py-2">Quotes</th>
                <th className="py-2">Target</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rfqs.map((rfq) => (
                <tr key={rfq.id} className="border-b" data-testid="rfq-row">
                  <td className="py-2">
                    <a className="underline" href={`/rfq/${rfq.id}`} data-testid={`rfq-link-${rfq.id}`}>
                      {rfq.title}
                    </a>
                  </td>
                  <td className="py-2">{rfq.mode}</td>
                  <td className="py-2" data-testid={`rfq-status-${rfq.id}`}>{rfq.status}</td>
                  <td className="py-2">{rfq._count.quotes}</td>
                  <td className="py-2">
                    {rfq.quantity === null ? "—" : `${rfq.quantity.toLocaleString("en-US")} units`}
                  </td>
                  <td className="py-2 text-right">
                    {rfq.status === "DRAFT" ? <SendRfqButton rfqId={rfq.id} /> : null}
                    {rfq.status === "OPEN" ? <CancelRfqButton rfqId={rfq.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-10 rounded-lg border border-neutral-200 p-6">
        <h2 className="text-lg font-medium">New RFQ</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Broadcast RFQs go to matched suppliers; auction RFQs close at the set time;
          all money stays in integer cents. Destination and need-by ride along with
          the structured spec.
        </p>
        <div className="mt-4 max-w-xl">
          <CreateRfqForm />
        </div>
      </section>
    </main>
  );
}
