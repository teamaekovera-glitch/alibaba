"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

/**
 * GET-form filter bar for the audit viewer — navigation-driven so every
 * filter state is a shareable URL (consistent with the catalog facets).
 */
const inputClass = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";

export function AuditFilterForm({
  initial,
}: {
  initial: { actorEmail?: string; actionPrefix?: string; entity?: string; from?: string; to?: string };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [values, setValues] = useState({
    actor: initial.actorEmail ?? "",
    action: initial.actionPrefix ?? "",
    entity: initial.entity ?? "",
    from: initial.from ?? "",
    to: initial.to ?? "",
  });

  const apply = () => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(values)) {
      if (value.trim()) {
        next.set(key, value.trim());
      } else {
        next.delete(key);
      }
    }
    router.push(`/admin/audit?${next.toString()}`);
  };

  const fields: Array<{ name: keyof typeof values; placeholder: string; testid: string }> = [
    { name: "actor", placeholder: "Actor email", testid: "audit-filter-actor" },
    { name: "action", placeholder: "Action prefix (e.g. review.)", testid: "audit-filter-action" },
    { name: "entity", placeholder: "Entity type", testid: "audit-filter-entity" },
    { name: "from", placeholder: "From (YYYY-MM-DD)", testid: "audit-filter-from" },
    { name: "to", placeholder: "To (YYYY-MM-DD)", testid: "audit-filter-to" },
  ];

  return (
    <form
      className="mt-4 grid gap-2 rounded-lg border border-neutral-200 bg-white p-4 sm:grid-cols-5"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      data-testid="audit-filter-form"
    >
      {fields.map((field) => (
        <input
          key={field.name}
          name={field.name}
          placeholder={field.placeholder}
          className={inputClass}
          value={values[field.name]}
          onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
          data-testid={field.testid}
        />
      ))}
      <button
        type="submit"
        className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white"
        data-testid="audit-filter-apply"
      >
        Apply filters
      </button>
    </form>
  );
}
