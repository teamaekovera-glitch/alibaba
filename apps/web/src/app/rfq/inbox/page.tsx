import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { tradeRepositories } from "@/lib/trade";

/** Supplier inbox: RFQ threads addressed to this supplier org, newest first. */
export default async function SupplierInboxPage() {
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const trade = await tradeRepositories();
  if (!trade) {
    redirect("/sign-in");
  }

  const threads = await trade.rfq.inbox();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold" data-testid="inbox-title">Supplier inbox</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Quote requests addressed to your organization. Respond with a quote —
        prices are quoted in integer cents and contact info stays redacted until
        an award.
      </p>

      {threads.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-600" data-testid="inbox-empty">
          No quote requests yet. Once a buyer sends an RFQ matching your
          listings, it appears here.
        </p>
      ) : (
        <ul className="mt-6 space-y-3" data-testid="inbox-list">
          {threads.map((thread) => {
            const rfq = thread.rfq;
            if (!rfq) {
              return null; // thread rows always carry an RFQ in this flow
            }
            const latest = thread.messages[0];
            return (
              <li key={thread.id} className="rounded-lg border border-neutral-200 p-4" data-testid="inbox-item">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Link className="font-medium underline" href={`/rfq/${rfq.id}`} data-testid={`inbox-link-${thread.id}`}>
                      {rfq.title}
                    </Link>
                    <p className="mt-1 text-xs text-neutral-500">
                      {rfq.mode} · RFQ status: {rfq.status}
                    </p>
                    {rfq.lines.length > 0 ? (
                      <p className="mt-1 text-sm text-neutral-700">
                        {rfq.lines[0]?.description} — {rfq.lines[0]?.quantity.toLocaleString("en-US")} units
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right text-xs text-neutral-500">
                    {latest?.body ? <p data-testid={`latest-message-${thread.id}`}>Latest: {latest.body.slice(0, 60)}</p> : null}
                    <Link className="underline" href={`/rfq/${rfq.id}`}>
                      Open RFQ
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-8 text-sm">
        <Link className="underline" href="/rfq">← RFQ dashboard</Link>
      </p>
    </main>
  );
}
