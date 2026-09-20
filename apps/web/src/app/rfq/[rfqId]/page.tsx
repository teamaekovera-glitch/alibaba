import { redirect } from "next/navigation";
import Link from "next/link";
import { RecordNotFoundError, computeLandedCost, landedCostComponentsFromQuote } from "@packsource/core";
import { auth } from "@/auth";
import { formatCents } from "@/lib/money";
import { tradeRepositories } from "@/lib/trade";
import {
  AddToCartButton,
  AcceptQuoteButton,
  CounterQuoteForm,
  DeclineQuoteButton,
  MessageForm,
  SendRfqButton,
  SubmitQuoteForm,
  WithdrawQuoteButton,
} from "../forms";

/**
 * RFQ detail. One page, two roles: the buyer sees threads, quotes, and landed
 * costs; the invited supplier sees the spec, their quotes, and the quote
 * builder. Participation is enforced by the repositories — an outsider org
 * gets RecordNotFound, not a data leak.
 */
export default async function RfqDetailPage({ params }: { params: Promise<{ rfqId: string }> }) {
  const { rfqId } = await params;
  const session = await auth();
  if (!session) {
    redirect("/sign-in");
  }
  const trade = await tradeRepositories();
  if (!trade) {
    redirect("/sign-in");
  }

  let rfq;
  try {
    rfq = await trade.rfq.rfqForActor(rfqId);
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return (
        <main className="mx-auto max-w-lg px-4 py-16 text-center" data-testid="rfq-not-found">
          <h1 className="text-xl font-semibold">RFQ not found</h1>
          <p className="mt-2 text-sm text-neutral-600">
            It does not exist or your organization has no access to it.
          </p>
          <Link className="mt-4 inline-block text-sm underline" href="/rfq">Back to RFQs</Link>
        </main>
      );
    }
    throw error;
  }

  const isBuyer = rfq.orgId === trade.authContext.orgId;
  const line = rfq.lines[0];
  const quotes = await trade.quotes.listForRfq(rfqId);

  // Buyer extras: threads (with supplier names) and, while still a draft,
  // the SQL matcher's supplier suggestions.
  const threads = isBuyer ? await trade.rfq.threadsForRfq(rfqId) : [];
  const matches = isBuyer && rfq.status === "DRAFT" ? await trade.rfq.matchSuppliers(rfqId) : [];

  // Supplier extras: their own thread on this RFQ (for messaging).
  const myThread = isBuyer ? null : (await trade.rfq.inbox()).find((t) => t.rfqId === rfqId) ?? null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <p className="text-sm">
        <Link className="underline" href={isBuyer ? "/rfq" : "/rfq/inbox"}>
          ← {isBuyer ? "RFQ dashboard" : "Inbox"}
        </Link>
      </p>

      <header className="mt-4">
        <h1 className="text-2xl font-semibold" data-testid="rfq-detail-title">{rfq.title}</h1>
        <p className="mt-1 text-sm text-neutral-600" data-testid="rfq-detail-meta">
          {rfq.mode} · <span data-testid="rfq-detail-status">{rfq.status}</span>
          {rfq.quantity !== null ? ` · ${rfq.quantity.toLocaleString("en-US")} units` : ""}
          {rfq.closesAt ? ` · closes ${rfq.closesAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}
        </p>
        {rfq.description ? <p className="mt-2 text-sm text-neutral-700">{rfq.description}</p> : null}
        {isBuyer && rfq.status === "DRAFT" ? (
          <div className="mt-3">
            <SendRfqButton rfqId={rfq.id} />
          </div>
        ) : null}
      </header>

      {line ? (
        <section className="mt-6 rounded-lg border border-neutral-200 p-4">
          <h2 className="text-sm font-medium">Requested item</h2>
          <p className="mt-1 text-sm" data-testid="rfq-line">
            {line.description} — {line.quantity.toLocaleString("en-US")} units
            {rfq.category ? ` · category: ${rfq.category.name}` : ""}
          </p>
        </section>
      ) : null}

      {isBuyer ? (
        <>
          {matches.length > 0 ? (
            <section className="mt-6">
              <h2 className="text-lg font-medium">Matched suppliers ({matches.length})</h2>
              <ul className="mt-2 text-sm" data-testid="match-list">
                {matches.slice(0, 10).map((m) => (
                  <li key={`${m.orgId}-${m.listingId}`} className="border-b py-1">
                    {m.listingTitle} — {m.score} attribute{m.score === 1 ? "" : "s"} matched
                    {m.unitPriceCents !== null ? ` · from ${formatCents(m.unitPriceCents)}/unit` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="mt-6">
            <h2 className="text-lg font-medium">Quotes ({quotes.length})</h2>
            {quotes.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-600" data-testid="quotes-empty">
                No quotes yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-3" data-testid="buyer-quote-list">
                {quotes.map((quote) => {
                  const landed = computeLandedCost(landedCostComponentsFromQuote(quote));
                  return (
                    <li key={quote.id} className="rounded-lg border border-neutral-200 p-4" data-testid="buyer-quote">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium" data-testid={`quote-supplier-${quote.id}`}>
                            {quote.org.name}
                          </p>
                          <p className="mt-1 text-sm text-neutral-700" data-testid={`quote-terms-${quote.id}`}>
                            {quote.quantity.toLocaleString("en-US")} units @ {formatCents(quote.unitPriceCents)}/unit ·
                            lead {quote.leadTimeDays}d · {quote.status}
                          </p>
                          <p className="mt-1 text-sm" data-testid={`quote-landed-${quote.id}`}>
                            Landed: <strong>{formatCents(landed.totalCents)}</strong> ({formatCents(landed.unitLandedCents)}/unit, incl.{" "}
                            {formatCents(landed.oneTimeCents)} one-time)
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {quote.status === "SUBMITTED" ? (
                            <>
                              <AddToCartButton quoteId={quote.id} />
                              <AcceptQuoteButton quoteId={quote.id} />
                              <DeclineQuoteButton quoteId={quote.id} />
                            </>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="mt-6">
            <h2 className="text-lg font-medium">Threads ({threads.length})</h2>
            <ul className="mt-2 space-y-3" data-testid="thread-list">
              {threads.map((thread) => (
                <li key={thread.id} className="rounded-lg border border-neutral-200 p-4">
                  <p className="text-sm font-medium">{thread.supplierOrg?.name ?? "Supplier"}</p>
                  <ThreadMessages threadId={thread.id} mine={isBuyer} />
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <>
          <section className="mt-6">
            <h2 className="text-lg font-medium">Submit a quote</h2>
            {rfq.status !== "OPEN" ? (
              <p className="mt-2 text-sm text-neutral-600" data-testid="quote-closed">
                This RFQ is {rfq.status} — quotes can only be submitted while it is open.
              </p>
            ) : (
              <div className="mt-3 max-w-xl">
                <SubmitQuoteForm rfqId={rfq.id} defaultQuantity={line?.quantity ?? null} />
              </div>
            )}
          </section>

          <section className="mt-6">
            <h2 className="text-lg font-medium">Your quotes ({quotes.length})</h2>
            {quotes.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-600" data-testid="supplier-quotes-empty">
                You have not quoted this RFQ yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-3" data-testid="supplier-quote-list">
                {quotes.map((quote) => (
                  <li key={quote.id} className="rounded-lg border border-neutral-200 p-4" data-testid="supplier-quote">
                    <p className="text-sm" data-testid={`supplier-quote-terms-${quote.id}`}>
                      {quote.quantity.toLocaleString("en-US")} units @ {formatCents(quote.unitPriceCents)}/unit ·
                      lead {quote.leadTimeDays}d · <span data-testid={`supplier-quote-status-${quote.id}`}>{quote.status}</span>
                    </p>
                    {quote.status === "SUBMITTED" ? (
                      <div className="mt-3 space-y-3">
                        <CounterQuoteForm
                          quoteId={quote.id}
                          defaultQuantity={quote.quantity}
                          defaultUnitPriceDollars={formatCents(quote.unitPriceCents).replace("$", "")}
                        />
                        <WithdrawQuoteButton quoteId={quote.id} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {myThread ? (
            <section className="mt-6">
              <h2 className="text-lg font-medium">Messages</h2>
              <ThreadMessages threadId={myThread.id} mine={isBuyer} />
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

/** Server-rendered thread transcript + composer. */
async function ThreadMessages({ threadId, mine }: { threadId: string; mine: boolean }) {
  const trade = await tradeRepositories();
  if (!trade) {
    return null;
  }
  const messages = await trade.negotiation.threadMessages(threadId);
  return (
    <div className="mt-3" data-testid={`thread-${threadId}`}>
      {messages.length === 0 ? (
        <p className="text-xs text-neutral-500">No messages yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="message-list">
          {messages.map((message) => (
            <li key={message.id} className="rounded-md bg-neutral-50 p-2 text-sm" data-testid="message-item">
              <span className="mr-2 text-xs text-neutral-500">{message.kind}</span>
              {message.body ?? ""}
            </li>
          ))}
        </ul>
      )}
      {mine ? (
        <div className="mt-2 max-w-md">
          <MessageForm threadId={threadId} />
        </div>
      ) : null}
    </div>
  );
}
