import { redirect } from "next/navigation";
import { staffContext } from "@/lib/admin/staff";
import { db } from "@/lib/db";
import { ReorderSweepForm } from "../forms";

/**
 * Notification operations (spec: notifications — deterministic, auditable
 * sends). Staff can trigger the deterministic reorder-reminder sweep as of a
 * chosen instant; each send is audited and lands in mock email + in-app
 * inboxes. Recent send events surface below from the append-only audit log.
 */
export default async function AdminNotificationsPage() {
  const auth = await staffContext();
  if (!auth) {
    redirect("/sign-in");
  }

  const recentSends = await db.auditLog.findMany({
    where: { action: { in: ["reorder.remind", "notification.sent"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
  });
  const actorIds = [...new Set(recentSends.map((event) => event.actorUserId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
    : [];

  return (
    <section>
      <h2 className="text-lg font-semibold" data-testid="admin-notifications-title">
        Notification operations
      </h2>
      <p className="mt-1 text-sm text-neutral-600">
        Trigger the deterministic reorder-reminder sweep. Due rules advance to
        their next cadence slot; members receive in-app notifications and mock
        email; every send is audited.
      </p>

      <ReorderSweepForm />

      <h3 className="mt-8 text-sm font-semibold">Recent send events</h3>
      {recentSends.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600" data-testid="admin-notifications-empty">
          No notification events yet.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {recentSends.map((event) => (
            <li key={event.id} className="rounded-md border border-neutral-100 bg-neutral-50 px-4 py-2 text-sm text-neutral-700" data-testid="admin-notifications-event">
              <span className="font-mono text-xs">{event.action}</span> ·{" "}
              {event.actorUserId
                ? (actors.find((actor) => actor.id === event.actorUserId)?.email ?? `${event.actorUserId.slice(0, 12)}…`)
                : "system"}{" "}
              · {event.createdAt.toISOString().replace("T", " ").slice(0, 19)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
