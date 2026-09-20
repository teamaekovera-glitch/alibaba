import { PermissionDeniedError } from "@packsource/core";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { formatCents } from "@/lib/money";
import { ordersRepositories } from "@/lib/orders";
import { SettlePayoutButton } from "../forms";

/**
 * Supplier payout ledger: suppliers see their own settlement legs; platform
 * staff see every payout and settle them (mock Connect transfers). Buyers
 * have no payout visibility.
 */
export default async function PayoutsPage() {
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const repos = await ordersRepositories();
  if (!repos) {
    redirect("/sign-in");
  }
  const isStaff = repos.authContext.role === "AEKOVERA_STAFF";

  let payouts;
  try {
    payouts = await repos.orders.listPayouts();
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return (
        <main className="mx-auto max-w-lg px-4 py-16 text-center" data-testid="payouts-forbidden">
          <h1 className="text-xl font-semibold">Payout ledger</h1>
          <p className="mt-2 text-sm text-neutral-600">
            Payouts are visible to supplier accounts and Aekovera staff.
          </p>
          <Link className="mt-4 inline-block text-sm underline" href="/orders">Back to orders</Link>
        </main>
      );
    }
    throw error;
  }

  const totals = payouts.reduce(
    (acc, payout) => {
      acc.net += payout.netCents;
      if (payout.status === "PENDING") {
        acc.pending += payout.netCents;
      } else {
        acc.settled += payout.netCents;
      }
      return acc;
    },
    { net: 0, pending: 0, settled: 0 },
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" data-testid="payouts-title">Payout ledger</h1>
        <Link className="text-sm underline" href="/orders" data-testid="back-to-orders">All orders</Link>
      </header>

      <div className="mt-4 grid grid-cols-3 gap-4 text-sm" data-testid="payout-totals">
        <div className="rounded-md border border-neutral-200 p-3">
          <p className="text-neutral-500">Net payable</p>
          <p className="font-medium">{formatCents(totals.net)}</p>
        </div>
        <div className="rounded-md border border-neutral-200 p-3">
          <p className="text-neutral-500">Pending settlement</p>
          <p className="font-medium" data-testid="payout-pending">{formatCents(totals.pending)}</p>
        </div>
        <div className="rounded-md border border-neutral-200 p-3">
          <p className="text-neutral-500">Settled</p>
          <p className="font-medium" data-testid="payout-settled">{formatCents(totals.settled)}</p>
        </div>
      </div>

      {payouts.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-600" data-testid="payouts-empty">
          No payouts yet — payout rows are created when escrow releases after delivery.
        </p>
      ) : (
        <table className="mt-6 w-full text-sm" data-testid="payout-table">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="py-1">Payout</th>
              <th className="py-1">Order</th>
              <th className="py-1">Status</th>
              <th className="py-1">Due</th>
              <th className="py-1 text-right">Gross</th>
              <th className="py-1 text-right">Commission</th>
              <th className="py-1 text-right">Net</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {payouts.map((payout) => (
              <tr key={payout.id} className="border-t border-neutral-200">
                <td className="py-1.5 font-mono text-xs">{payout.id}</td>
                <td className="py-1.5">
                  <Link className="underline font-mono text-xs" href={`/orders/${payout.orderId}`}>{payout.orderId}</Link>
                </td>
                <td className="py-1.5" data-testid="payout-status">{payout.status}</td>
                <td className="py-1.5">{payout.dueAt ? payout.dueAt.toISOString().slice(0, 10) : "—"}</td>
                <td className="py-1.5 text-right">{formatCents(payout.amountCents)}</td>
                <td className="py-1.5 text-right">{formatCents(payout.commissionCents)}</td>
                <td className="py-1.5 text-right" data-testid="payout-net">{formatCents(payout.netCents)}</td>
                <td className="py-1.5 text-right">
                  {isStaff && payout.status === "PENDING" ? (
                    <SettlePayoutButton payoutId={payout.id} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
