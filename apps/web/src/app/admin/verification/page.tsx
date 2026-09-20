import { redirect } from "next/navigation";
import { staffContext } from "@/lib/admin/staff";
import { verificationQueue } from "@/lib/admin/verification";
import { VerificationForm } from "../forms";

/**
 * Organization verification management (spec: administration — verification
 * tier changes, audited). Supplier orgs are listed with their current
 * verification status and a tier form; changes are permission-checked and
 * audited in setVerificationTier. Unverified suppliers sort first — they are
 * the actionable queue.
 */
export default async function VerificationPage() {
  const auth = await staffContext();
  if (!auth) {
    redirect("/sign-in");
  }
  const orgs = await verificationQueue(auth);
  const pendingFirst = [...orgs].sort(
    (a, b) =>
      Number(a.supplierProfile?.verificationStatus === "UNVERIFIED") -
      Number(b.supplierProfile?.verificationStatus === "UNVERIFIED"),
  );

  return (
    <section>
      <h2 className="text-lg font-semibold" data-testid="verification-title">
        Organization verification
      </h2>
      <p className="mt-1 text-sm text-neutral-600">
        Review supplier verification status. Changes are audited with your
        staff identity and notify the supplier organization.
      </p>

      <ul className="mt-4 flex flex-col gap-4">
        {pendingFirst.map((org) => {
          const status = org.supplierProfile?.verificationStatus ?? "NO_SUPPLIER_PROFILE";
          return (
            <li key={org.id} className="rounded-lg border border-neutral-200 bg-white p-5" data-testid="verification-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium" data-testid="verification-item-name">
                    {org.name}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {org.slug} · {org._count.members} member(s)
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    status === "VERIFIED"
                      ? "bg-green-50 text-green-700"
                      : status === "AEKOVERA_VETTED"
                        ? "bg-blue-50 text-blue-700"
                        : status === "UNVERIFIED"
                          ? "bg-amber-50 text-amber-700"
                          : "bg-neutral-100 text-neutral-600"
                  }`}
                  data-testid="verification-item-status"
                >
                  {status}
                </span>
              </div>
              {org.supplierProfile ? (
                <VerificationForm orgId={org.id} currentTier={org.supplierProfile.verificationStatus} />
              ) : (
                <p className="mt-2 text-xs text-neutral-500">No supplier profile — buyer organization.</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
