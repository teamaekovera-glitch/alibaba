import Link from "next/link";
import { redirect } from "next/navigation";
import { notificationCenter } from "@/lib/notifications";
import { sessionAuthContext } from "@/lib/admin/staff";
import { MarkAllReadForm, MarkReadForm } from "./forms";

/**
 * In-app notification center (spec: notifications — list, unread state, mark
 * read). Personal inbox: any signed-in user sees exactly their own
 * notifications; guests are redirected to sign-in. `unreadOnly=1` filters to
 * unread, and the unread count is always surfaced.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ unreadOnly?: string }>;
}) {
  const auth = await sessionAuthContext();
  if (!auth) {
    redirect("/sign-in");
  }
  const params = await searchParams;
  const unreadOnly = params.unreadOnly === "1";
  const center = notificationCenter(auth);
  const [items, unread] = await Promise.all([
    center.list({ unreadOnly, limit: 100 }),
    center.unreadCount(),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="notifications-title">
            Notifications
          </h1>
          <p className="mt-1 text-sm text-neutral-600" data-testid="notifications-unread-count">
            {unread} unread
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={unreadOnly ? "/notifications" : "/notifications?unreadOnly=1"}
            className="text-sm text-neutral-600 underline hover:text-neutral-900"
            data-testid="notifications-toggle-unread"
          >
            {unreadOnly ? "Show all" : "Unread only"}
          </Link>
          {unread > 0 ? <MarkAllReadForm /> : null}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="mt-8 rounded-lg border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-600" data-testid="notifications-empty">
          {unreadOnly ? "Nothing unread — you are all caught up." : "No notifications yet."}
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {items.map((notification) => {
            const isUnread = notification.readAt === null;
            return (
              <li
                key={notification.id}
                className={`rounded-lg border bg-white p-4 ${
                  isUnread ? "border-neutral-300" : "border-neutral-100 opacity-75"
                }`}
                data-testid="notification-item"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className={`text-sm ${isUnread ? "font-semibold" : "text-neutral-700"}`} data-testid="notification-item-title">
                      {notification.title}
                      {isUnread ? (
                        <span className="ml-2 inline-block h-2 w-2 rounded-full bg-blue-500" aria-label="unread" />
                      ) : null}
                    </p>
                    {notification.body ? (
                      <p className="mt-0.5 text-sm text-neutral-600">{notification.body}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-neutral-400">
                      {notification.kind} · {notification.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                    </p>
                  </div>
                  {isUnread ? <MarkReadForm notificationId={notification.id} /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
