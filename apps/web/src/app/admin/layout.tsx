import Link from "next/link";
import { redirect } from "next/navigation";
import { sessionAuthContext, isAdminRole } from "@/lib/admin/staff";

/**
 * Admin console shell (spec: administration — platform-admin gated). The
 * gate lives HERE so every /admin/* surface inherits it: guests are sent to
 * sign-in, any signed-in non-admin sees a forbidden panel instead of data.
 * Individual queues additionally re-gate their reads through the
 * lib/admin layer's assertCan calls (defense in depth).
 */

const NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/moderation", label: "Review moderation" },
  { href: "/admin/disputes", label: "Disputes" },
  { href: "/admin/verification", label: "Verification" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/organizations", label: "Organizations" },
  { href: "/admin/notifications", label: "Reminders" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const auth = await sessionAuthContext();
  if (!auth) {
    redirect("/sign-in");
  }
  if (!isAdminRole(auth.role)) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16 text-center" data-testid="admin-forbidden">
        <h1 className="text-xl font-semibold">Admin console</h1>
        <p className="mt-2 text-sm text-neutral-600">
          The admin console is restricted to Aekovera platform staff.
        </p>
        <Link className="mt-4 inline-block text-sm underline" href="/">
          Back to marketplace
        </Link>
      </main>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Aekovera staff</p>
        <h1 className="text-2xl font-semibold" data-testid="admin-title">
          Admin console
        </h1>
        <nav className="mt-4 flex flex-wrap gap-4 border-b border-neutral-200 pb-3 text-sm" aria-label="Admin">
          {NAV.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="text-neutral-600 hover:text-neutral-900"
              data-testid={`admin-nav-${entry.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {entry.label}
            </Link>
          ))}
        </nav>
      </header>
      <div className="mt-6">{children}</div>
    </div>
  );
}
