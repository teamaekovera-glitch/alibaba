import { redirect } from "next/navigation";
import { staffContext } from "@/lib/admin/staff";
import { staffDisputes } from "@/lib/admin/disputes";
import { formatCents } from "@/lib/money";
import { DisputeResolutionForm } from "../forms";

/**
 * Dispute staff resolution view (spec: administration — dispute mediation).
 * Shows each dispute with its order context; the resolution form's outcomes
 * map onto OrderRepository.resolveDispute's escrow contract exactly
 * (release / full refund / partial refund / return to delivered). Resolving
 * moves the order out of the dispute hold per PR #11's state machine.
 */
export default async function DisputesPage() {
  const auth = await staffContext();
  if (!auth) {
    redirect("/sign-in");
  }
  const [openDisputes, resolved] = await Promise.all([
    staffDisputes(auth, { status: "OPEN" }),
    staffDisputes(auth, { status: "RESOLVED" }),
  ]);

  return (
    <section>
      <h2 className="text-lg font-semibold" data-testid="disputes-title">
        Disputes
      </h2>
      <p className="mt-1 text-sm text-neutral-600">
        Open disputes hold escrow release. Resolving applies the outcome to
        the order and escrow exactly as the order contracts define it.
      </p>

      {openDisputes.length === 0 ? (
        <p className="mt-6 rounded-md border border-neutral-200 bg-white p-6 text-sm text-neutral-600" data-testid="disputes-empty">
          No open disputes.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {openDisputes.map((dispute) => (
            <li key={dispute.id} className="rounded-lg border border-neutral-200 bg-white p-5" data-testid="dispute-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium" data-testid="dispute-item-reason">
                  {dispute.reason}
                </p>
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                  {dispute.status}
                </span>
              </div>
              {dispute.detail ? <p className="mt-1 text-sm text-neutral-700">{dispute.detail}</p> : null}
              <p className="mt-1 text-xs text-neutral-500">
                Order {dispute.order.id} ({dispute.order.status.toLowerCase()}) ·{" "}
                {formatCents(dispute.order.totalCents)} · opened by {dispute.openedByUser.email} ·{" "}
                {dispute.createdAt.toISOString().slice(0, 10)}
              </p>
              <DisputeResolutionForm disputeId={dispute.id} />
            </li>
          ))}
        </ul>
      )}

      {resolved.length > 0 ? (
        <div className="mt-8">
          <h3 className="text-sm font-semibold">Recently resolved</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {resolved.slice(0, 5).map((dispute) => (
              <li
                key={dispute.id}
                className="rounded-md border border-neutral-100 bg-neutral-50 px-4 py-3 text-sm text-neutral-700"
                data-testid="dispute-resolved-item"
              >
                {dispute.reason} · outcome {dispute.outcome ?? "—"} ·{" "}
                {dispute.resolvedAt?.toISOString().slice(0, 10) ?? "in progress"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
