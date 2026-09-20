import { redirect } from "next/navigation";
import { staffContext } from "@/lib/admin/staff";
import { adminOrganizations } from "@/lib/admin/directory";
import { MemberAdminForm } from "../forms";

/**
 * Basic org/user administration (spec: administration — organization and
 * membership administration). Staff see every organization with its members
 * and can change roles or remove members; every mutation is permission
 * checked and audited in the lib/admin directory module. Roles assignable
 * from the console exclude the staff role itself.
 */
export default async function OrganizationsPage() {
  const auth = await staffContext();
  if (!auth) {
    redirect("/sign-in");
  }
  const orgs = await adminOrganizations(auth);

  return (
    <section>
      <h2 className="text-lg font-semibold" data-testid="organizations-title">
        Organizations
      </h2>
      <p className="mt-1 text-sm text-neutral-600">
        All organizations on the platform with their members. Role changes and
        removals are audited.
      </p>

      {orgs.length === 0 ? (
        <p className="mt-6 rounded-md border border-neutral-200 bg-white p-6 text-sm text-neutral-600" data-testid="organizations-empty">
          No organizations found.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {orgs.map((org) => (
            <li key={org.id} className="rounded-lg border border-neutral-200 bg-white p-5" data-testid="organization-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium" data-testid="organization-item-name">
                    {org.name}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {org.slug} · {org.type.toLowerCase()} · {org._count.members} member(s)
                  </p>
                </div>
                {org.supplierProfile ? (
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
                    verification: {org.supplierProfile.verificationStatus}
                  </span>
                ) : null}
              </div>
              <ul className="mt-3 divide-y divide-neutral-100">
                {org.members.map((membership) => (
                  <li key={membership.id} className="py-2" data-testid="organization-member">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm">
                        {membership.user.email}
                        <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
                          {membership.role}
                        </span>
                      </p>
                      <MemberAdminForm membershipId={membership.id} currentRole={membership.role} />
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
