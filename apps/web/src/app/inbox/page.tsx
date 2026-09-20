import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { messagingRepository } from "@/lib/messaging";

/**
 * Inbox: the acting org's threads, newest activity first, with unread
 * counts (spec: "Unread indicators"). Scoping and unread accounting live
 * in core; this page renders. Counterparty names are public storefront
 * fields (profiles already render them), so they are looked up directly.
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const messaging = await messagingRepository();
  if (!messaging) {
    redirect("/sign-in");
  }

  const params = await searchParams;
  const before = params.before ? new Date(params.before) : undefined;
  const validBefore = before !== undefined && !Number.isNaN(before.getTime()) ? before : undefined;
  const page = await messaging.messaging.listThreads({ limit: 20, ...(validBefore ? { before: validBefore } : {}) });

  const orgIds = [...new Set(page.threads.flatMap((t) => [t.buyerOrgId, t.supplierOrgId]).filter((id): id is string => id !== null))];
  const orgs = orgIds.length > 0
    ? await db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
    : [];
  const orgName = new Map(orgs.map((org) => [org.id, org.name]));
  const myOrgId = messaging.authContext.orgId;
  const threadLabel = (thread: { buyerOrgId: string | null; supplierOrgId: string | null; subject: string | null; kind: string; orderId: string | null }) => {
    if (thread.subject) {
      return thread.subject;
    }
    const counterpartyId = thread.buyerOrgId === myOrgId ? thread.supplierOrgId : thread.buyerOrgId;
    const counterparty = counterpartyId ? orgName.get(counterpartyId) ?? "counterparty" : "counterparty";
    return `${thread.kind} thread with ${counterparty}`;
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" data-testid="inbox-title">
          Inbox
        </h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/orders" data-testid="nav-orders">
            Orders
          </Link>
          <Link className="underline" href="/rfq" data-testid="nav-rfq">
            RFQs
          </Link>
        </nav>
      </header>

      {page.threads.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-600" data-testid="inbox-empty">
          No conversations yet — start one from an order or a supplier profile.
        </p>
      ) : (
        <ul className="mt-6 space-y-2" data-testid="thread-list">
          {page.threads.map((thread) => (
            <li key={thread.id} className="rounded-lg border border-neutral-200 p-4">
              <div className="flex items-center justify-between gap-4">
                <Link
                  href={`/inbox/${thread.id}`}
                  className="text-sm font-medium underline"
                  data-testid={`thread-link-${thread.id}`}
                >
                  {threadLabel(thread)}
                  <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">{thread.kind}</span>
                </Link>
                {thread.unreadCount > 0 ? (
                  <span
                    className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs font-medium text-white"
                    data-testid={`thread-unread-${thread.id}`}
                  >
                    {thread.unreadCount} unread
                  </span>
                ) : null}
              </div>
              {thread.lastMessage ? (
                <p className="mt-1 line-clamp-1 text-sm text-neutral-600">
                  {thread.lastMessage.body ?? "(attachment)"} ·{" "}
                  {thread.lastMessage.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {page.nextBefore ? (
        <p className="mt-4">
          <Link
            href={`/inbox?before=${encodeURIComponent(page.nextBefore.toISOString())}`}
            className="text-sm underline"
            data-testid="inbox-older"
          >
            Older threads
          </Link>
        </p>
      ) : null}
    </main>
  );
}
