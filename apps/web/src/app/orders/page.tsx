import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { formatCents } from "@/lib/money";
import { ordersRepositories } from "@/lib/orders";

/**
 * Order dashboard: buyer orgs see the orders they placed; supplier orgs see
 * the orders they have a fulfillment leg on (their leg statuses shown);
 * staff get a pointer to the payout ledger. Scoping lives in core.
 */
export default async function OrdersPage() {
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const orders = await ordersRepositories();
  if (!orders) {
    redirect("/sign-in");
  }

  const [buyerOrders, supplierOrders] = await Promise.all([
    orders.orders.listBuyerOrders(),
    orders.orders.listSupplierOrders(),
  ]);

  const isStaff = orders.authContext.role === "AEKOVERA_STAFF";

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" data-testid="orders-title">Orders</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/rfq" data-testid="nav-rfq">RFQs</Link>
          <Link className="underline" href="/orders/payouts" data-testid="nav-payouts">Payouts</Link>
        </nav>
      </header>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Orders you placed</h2>
        {buyerOrders.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600" data-testid="buyer-orders-empty">
            {isStaff
              ? "Platform staff see no buyer orders — use the payout ledger."
              : "No orders yet — award a quote from your cart to create one."}
          </p>
        ) : (
          <table className="mt-3 w-full text-sm" data-testid="buyer-orders-table">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="py-1">Order</th>
                <th className="py-1">Status</th>
                <th className="py-1">Schedule</th>
                <th className="py-1 text-right">Total</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {buyerOrders.map((order) => (
                <tr key={order.id} className="border-t border-neutral-200">
                  <td className="py-1.5 font-mono text-xs">{order.id}</td>
                  <td className="py-1.5" data-testid="order-status">{order.status}</td>
                  <td className="py-1.5">{order.paymentSchedule}</td>
                  <td className="py-1.5 text-right">{formatCents(order.totalCents)}</td>
                  <td className="py-1.5 text-right">
                    <Link className="underline" href={`/orders/${order.id}`} data-testid="order-link">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Orders you fulfill</h2>
        {supplierOrders.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600" data-testid="supplier-orders-empty">
            No fulfillment legs yet — orders awarded to your quotes appear here.
          </p>
        ) : (
          <table className="mt-3 w-full text-sm" data-testid="supplier-orders-table">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="py-1">Order</th>
                <th className="py-1">Status</th>
                <th className="py-1">Your legs</th>
                <th className="py-1 text-right">Order total</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {supplierOrders.map((order) => (
                <tr key={order.id} className="border-t border-neutral-200">
                  <td className="py-1.5 font-mono text-xs">{order.id}</td>
                  <td className="py-1.5">{order.status}</td>
                  <td className="py-1.5">
                    {order.subOrders
                      .filter((leg) => leg.orgId === orders.authContext.orgId)
                      .map((leg) => leg.status)
                      .join(", ")}
                  </td>
                  <td className="py-1.5 text-right">{formatCents(order.totalCents)}</td>
                  <td className="py-1.5 text-right">
                    <Link className="underline" href={`/orders/${order.id}`} data-testid="supplier-order-link">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
