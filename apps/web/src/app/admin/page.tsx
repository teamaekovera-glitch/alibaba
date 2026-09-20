import Link from "next/link";
import { redirect } from "next/navigation";
import { staffContext } from "@/lib/admin/staff";
import { moderationQueue } from "@/lib/admin/moderation";
import { staffDisputes } from "@/lib/admin/disputes";
import { verificationQueue } from "@/lib/admin/verification";

/**
 * Admin dashboard (spec: administration — the staff landing surface): the
 * three operational queues with counts, plus the audit trail entry point.
 * Counts come from the same staff-gated queue reads the sub-pages use.
 */
export default async function AdminDashboardPage() {
  const auth = await staffContext();
  if (!auth) {
    redirect("/sign-in");
  }

  const [pendingReviews, openDisputes, supplierOrgs] = await Promise.all([
    moderationQueue(auth),
    staffDisputes(auth, { status: "OPEN" }),
    verificationQueue(auth),
  ]);
  // Actionable verification work = suppliers still unverified.
  const unverified = supplierOrgs.filter(
    (org) => org.supplierProfile?.verificationStatus === "UNVERIFIED",
  );

  const queues = [
    {
      href: "/admin/moderation",
      label: "Reviews awaiting moderation",
      count: pendingReviews.length,
      testid: "queue-moderation",
    },
    {
      href: "/admin/disputes",
      label: "Open disputes",
      count: openDisputes.length,
      testid: "queue-disputes",
    },
    {
      href: "/admin/verification",
      label: "Suppliers awaiting verification",
      count: unverified.length,
      testid: "queue-verification",
    },
  ];

  return (
    <section>
      <div className="grid gap-4 sm:grid-cols-3">
        {queues.map((queue) => (
          <Link
            key={queue.href}
            href={queue.href}
            className="rounded-lg border border-neutral-200 bg-white p-5 hover:border-neutral-300"
            data-testid={queue.testid}
          >
            <p className="text-3xl font-semibold" data-testid={`${queue.testid}-count`}>
              {queue.count}
            </p>
            <p className="mt-1 text-sm text-neutral-600">{queue.label}</p>
          </Link>
        ))}
      </div>
      <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold">Audit trail</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Every staff action, moderation decision, verification change, dispute
          resolution, and notification send lands in the append-only audit log.
        </p>
        <Link className="mt-2 inline-block text-sm underline" href="/admin/audit" data-testid="queue-audit">
          Open the audit log viewer
        </Link>
      </div>
    </section>
  );
}
