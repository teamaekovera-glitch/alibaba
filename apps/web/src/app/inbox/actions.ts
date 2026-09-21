"use server";

import { MessagingError, PermissionDeniedError, RecordNotFoundError } from "@packsource/core";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { messagingRepository } from "@/lib/messaging";

/**
 * Messaging server actions (threads, posts, read markers). Same contract as
 * the orders actions: handlers parse FormData and translate domain errors
 * into form-renderable messages — every permission gate, org scope, and
 * redaction rule lives in packages/core.
 */

export type ActionState = { ok: true; message?: string } | { error: string } | null;

const DOMAIN_ERRORS = [PermissionDeniedError, RecordNotFoundError, MessagingError] as const;

type MessagingSession = NonNullable<Awaited<ReturnType<typeof messagingRepository>>>;

async function withMessaging(
  run: (messaging: MessagingSession["messaging"]) => Promise<unknown>,
  paths: string[] = ["/inbox"],
): Promise<ActionState> {
  const session = await messagingRepository();
  if (!session) {
    redirect("/sign-in");
  }
  try {
    const result = await run(session.messaging);
    for (const path of paths) {
      revalidatePath(path);
    }
    return { ok: true, message: typeof result === "string" ? result : undefined };
  } catch (error) {
    if (DOMAIN_ERRORS.some((kind) => error instanceof kind)) {
      return { error: error instanceof Error ? error.message : "Action failed" };
    }
    throw error; // unknown errors must surface, not become form copy
  }
}

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Start an ORDER thread (from an order detail page) and redirect to it. */
export async function startOrderThreadAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const orderId = str(form, "orderId");
  const body = str(form, "body");
  let threadId: string | undefined;
  const state = await withMessaging(async (messaging) => {
    const { thread } = await messaging.startThread({ kind: "ORDER", orderId, body });
    threadId = thread.id;
    revalidatePath(`/inbox/${thread.id}`);
    return "Thread started";
  }, ["/orders"]);
  if (state && "ok" in state && threadId) {
    redirect(`/inbox/${threadId}`);
  }
  return state;
}

/** Post a message from the thread view. */
export async function postMessageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const threadId = str(form, "threadId");
  const body = str(form, "body");
  if (!body) {
    return { error: "Write a message first" };
  }
  return withMessaging((messaging) => messaging.postMessage(threadId, { body }), [
    "/inbox",
    `/inbox/${threadId}`,
  ]);
}

/** Mark a thread read (read cursor upsert). */
export async function markReadAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const threadId = str(form, "threadId");
  return withMessaging((messaging) => messaging.markRead(threadId), ["/inbox", `/inbox/${threadId}`]);
}
