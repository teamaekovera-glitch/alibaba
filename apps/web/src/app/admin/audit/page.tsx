import { redirect } from "next/navigation";
import { staffContext } from "@/lib/admin/staff";
import { auditLogPage } from "@/lib/admin/audit";
import { AuditFilterForm } from "./filter-form";

/**
 * Filterable audit log viewer (spec: administration — staff audit
 * visibility). Filters: actor email, action prefix, entity type, date range.
 * The log is append-only — this page is read-only by construction (no
 * actions imported).
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; action?: string; entity?: string; from?: string; to?: string }>;
}) {
  const auth = await staffContext();
  if (!auth) {
    redirect("/sign-in");
  }
  const params = await searchParams;
  const filters = {
    actorEmail: params.actor?.trim() || undefined,
    actionPrefix: params.action?.trim() || undefined,
    entity: params.entity?.trim() || undefined,
    from: params.from?.trim() || undefined,
    to: params.to?.trim() || undefined,
  };
  const { rows, actorEmails } = await auditLogPage(auth, filters);

  return (
    <section>
      <h2 className="text-lg font-semibold" data-testid="audit-title">
        Audit log
      </h2>
      <p className="mt-1 text-sm text-neutral-600">
        Append-only record of every audited action, newest first. Filter by
        actor, action prefix, entity type, or date range.
      </p>

      <AuditFilterForm initial={filters} />

      {rows.length === 0 ? (
        <p className="mt-6 rounded-md border border-neutral-200 bg-white p-6 text-sm text-neutral-600" data-testid="audit-empty">
          No audit entries match these filters.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-left text-sm" data-testid="audit-table">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">When (UTC)</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Actor</th>
                <th className="px-4 py-2 font-medium">Entity</th>
                <th className="px-4 py-2 font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id} className="border-b border-neutral-100 last:border-0" data-testid="audit-row">
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-neutral-500">
                    {entry.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs" data-testid="audit-row-action">
                    {entry.action}
                  </td>
                  <td className="px-4 py-2 text-xs" data-testid="audit-row-actor">
                    {entry.actorUserId
                      ? (actorEmails[entry.actorUserId] ?? `${entry.actorUserId.slice(0, 12)}… (${entry.actorType})`)
                      : entry.actorType}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-500">
                    {entry.entityType}:{entry.entityId.slice(0, 12)}
                  </td>
                  <td className="px-4 py-2 text-xs text-neutral-600">
                    <code className="break-all">{JSON.stringify(entry.after ?? {})}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
