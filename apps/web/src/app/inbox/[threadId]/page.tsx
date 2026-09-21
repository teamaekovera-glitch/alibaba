import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { messagingRepository } from "@/lib/messaging";
import { MarkReadForm, PostMessageForm } from "../forms";

/**
 * Thread view: messages oldest-first with keyset "older" pagination, a post
 * form, a read cursor, and the contact panel (spec: contact details appear
 * only once the sharing policy unlocks — bodies stay redacted either way).
 * Unknown or wrong-org threads surface the same not-found state.
 */
export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const messaging = await messagingRepository();
  if (!messaging) {
    redirect("/sign-in");
  }

  const { threadId } = await params;
  const query = await searchParams;
  // Opaque composite cursor from the core repository — passed through as-is.
  const before = query.before;

  const [thread, messages] = await Promise.all([
    messaging.messaging.threadSummary(threadId).catch(() => null), // RecordNotFoundError: wrong-org or unknown thread
    messaging.messaging
      .threadMessages(threadId, { limit: 30, ...(before ? { before } : {}) })
      .catch(() => null),
  ]);
  if (!thread || !messages) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold" data-testid="thread-missing">
          Thread not found
        </h1>
        <p className="mt-2 text-sm">
          <Link className="underline" href="/inbox">
            Back to inbox
          </Link>
        </p>
      </main>
    );
  }

  const myOrgId = messaging.authContext.orgId;
  const [contact, orgs] = await Promise.all([
    messaging.messaging.contactPolicy(threadId),
    db.organization.findMany({
      where: { id: { in: [thread.buyerOrgId, thread.supplierOrgId].filter((id): id is string => id !== null) } },
      select: { id: true, name: true },
    }),
  ]);
  const orgName = new Map(orgs.map((org) => [org.id, org.name]));
  const counterpartyId = thread.buyerOrgId === myOrgId ? thread.supplierOrgId : thread.buyerOrgId;
  const counterpartyName = counterpartyId ? (orgName.get(counterpartyId) ?? "counterparty") : "counterparty";
  const label = thread.subject ?? `${thread.kind} thread with ${counterpartyName}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-neutral-500">
            <Link className="underline" href="/inbox" data-testid="back-to-inbox">
              Inbox
            </Link>{" "}
            · {thread.kind}
            {thread.orderId ? (
              <>
                {" · "}
                <Link className="underline" href={`/orders/${thread.orderId}`}>
                  order
                </Link>
              </>
            ) : null}
          </p>
          <h1 className="text-2xl font-semibold" data-testid="thread-title">
            {label}
          </h1>
          <p className="text-sm text-neutral-600">
            {thread.buyerOrgId === myOrgId ? "You are the buyer" : "You are the supplier"} · with {counterpartyName}
          </p>
        </div>
        {thread.unreadCount > 0 ? <MarkReadForm threadId={thread.id} /> : null}
      </header>

      {messages.nextBefore ? (
        <p className="mt-4 text-sm">
          <Link
            href={`/inbox/${thread.id}?before=${encodeURIComponent(messages.nextBefore)}`}
            className="underline"
            data-testid="messages-older"
          >
            Load older messages
          </Link>
        </p>
      ) : null}

      <section className="mt-6 space-y-3" data-testid="message-list">
        {messages.messages.length === 0 ? (
          <p className="text-sm text-neutral-600">No messages on this page.</p>
        ) : (
          messages.messages.map((message) => (
            <article
              key={message.id}
              className={`rounded-lg border p-3 text-sm ${
                message.orgId === myOrgId ? "border-neutral-300 bg-neutral-50" : "border-neutral-200"
              }`}
              data-testid={`message-${message.id}`}
            >
              <p className="text-xs text-neutral-500">
                {message.orgId === myOrgId ? "You" : (orgName.get(message.orgId) ?? "Counterparty")} ·{" "}
                {message.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </p>
              {message.body ? <p className="mt-1 whitespace-pre-wrap">{message.body}</p> : null}
              {message.attachments.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-xs text-neutral-600" data-testid={`message-attachments-${message.id}`}>
                  {message.attachments.map((attachment) => (
                    <li key={attachment.id}>{attachment.filename}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium">Reply</h2>
        <div className="mt-2">
          <PostMessageForm threadId={thread.id} />
        </div>
      </section>

      <aside className="mt-8 rounded-lg border border-neutral-200 p-4 text-sm" data-testid="contact-policy">
        {contact.canShareContacts && contact.contact ? (
          <>
            <h2 className="font-medium">Contact shared</h2>
            <p className="mt-1 text-neutral-700">
              {contact.contact.orgName} — {contact.contact.billingEmail ?? "no billing email on file"}
            </p>
          </>
        ) : (
          <>
            <h2 className="font-medium">Contact sharing locked</h2>
            <p className="mt-1 text-neutral-600">
              Direct emails and phone numbers are removed from messages. Contact details unlock when a quote from
              this conversation is accepted into an order, or when the buyer is a verified buyer.
            </p>
          </>
        )}
      </aside>
    </main>
  );
}
