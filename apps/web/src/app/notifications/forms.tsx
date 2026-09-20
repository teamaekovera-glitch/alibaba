"use client";

import { useActionState } from "react";
import { markAllNotificationsReadAction, markNotificationReadAction } from "./actions";

/** Notification-center client forms (same pattern as the order forms). */

function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}

export function MarkReadForm({ notificationId }: { notificationId: string }) {
  const [state, submit, pending] = useActionState(markNotificationReadAction, null);
  return (
    <form action={submit} className="contents">
      <Hidden name="notificationId" value={notificationId} />
      <button
        type="submit"
        disabled={pending}
        data-testid={`mark-read-${notificationId}`}
        className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "…" : "Mark read"}
      </button>
      {state && "error" in state ? (
        <span className="text-xs text-red-600" data-testid="form-error">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

export function MarkAllReadForm() {
  const [state, submit, pending] = useActionState(markAllNotificationsReadAction, null);
  return (
    <form action={submit} className="inline">
      <button
        type="submit"
        disabled={pending}
        data-testid="mark-all-read"
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "Working…" : "Mark all read"}
      </button>
      {state && "message" in state && state.message ? (
        <span className="ml-2 text-xs text-green-700" data-testid="form-ok">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
