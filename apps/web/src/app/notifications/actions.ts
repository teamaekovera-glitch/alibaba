"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PermissionDeniedError, RecordNotFoundError } from "@packsource/core";
import { notificationCenter } from "@/lib/notifications";
import { sessionAuthContext } from "@/lib/admin/staff";

/**
 * Notification-center server actions. Personal data: the repository is
 * constructed from the acting session and every method is user-scoped, so a
 * caller can only ever touch their own inbox. Cross-user ids 404 through the
 * repository, surfacing as form copy — never a silent no-op.
 */

export type NotificationActionState = { ok: true; message?: string } | { error: string } | null;

export async function markNotificationReadAction(
  _prev: NotificationActionState,
  formData: FormData,
): Promise<NotificationActionState> {
  const session = await sessionAuthContext();
  if (!session) {
    redirect("/sign-in");
  }
  const notificationId = String(formData.get("notificationId") ?? "");
  try {
    await notificationCenter(session).markRead(notificationId, new Date());
  } catch (error) {
    if (error instanceof PermissionDeniedError || error instanceof RecordNotFoundError) {
      return { error: "Notification not found." };
    }
    throw error; // unknown errors must surface, not become form copy
  }
  revalidatePath("/notifications");
  return { ok: true };
}

export async function markAllNotificationsReadAction(
  _prev: NotificationActionState,
): Promise<NotificationActionState> {
  const session = await sessionAuthContext();
  if (!session) {
    redirect("/sign-in");
  }
  await notificationCenter(session).markAllRead(new Date());
  revalidatePath("/notifications");
  return { ok: true, message: "All notifications marked read." };
}
