"use client";

import { useActionState } from "react";
import type { ActionState } from "./actions";
import { markReadAction, postMessageAction, startOrderThreadAction } from "./actions";

function Feedback({ state }: { state: ActionState }) {
  if (!state) {
    return null;
  }
  if ("error" in state) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="form-error">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700" data-testid="form-ok">
        {state.message}
      </p>
    );
  }
  return null;
}

const inputClass = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const buttonClass = "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

export function PostMessageForm({ threadId }: { threadId: string }) {
  const [state, action, pending] = useActionState(postMessageAction, null);
  return (
    <form action={action} className="space-y-2">
      <Feedback state={state} />
      <input type="hidden" name="threadId" value={threadId} />
      <textarea
        name="body"
        rows={3}
        required
        placeholder="Write a message — emails and phone numbers are removed until contact sharing unlocks."
        className={inputClass}
        data-testid="message-body"
      />
      <button type="submit" disabled={pending} className={buttonClass} data-testid="message-send">
        {pending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}

export function MarkReadForm({ threadId, label = "Mark read" }: { threadId: string; label?: string }) {
  const [state, action, pending] = useActionState(markReadAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="threadId" value={threadId} />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className="text-xs underline text-neutral-600" data-testid="mark-read">
        {pending ? "…" : label}
      </button>
    </form>
  );
}

/** Start an ORDER thread from the order detail page and jump into it. */
export function StartOrderThreadForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(startOrderThreadAction, null);
  return (
    <form action={action} className="space-y-2">
      <Feedback state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <textarea
        name="body"
        rows={2}
        placeholder="Say what the thread is about — e.g. a packaging change or a delivery question."
        className={inputClass}
        data-testid="order-thread-body"
      />
      <button type="submit" disabled={pending} className={buttonClass} data-testid="order-thread-start">
        {pending ? "Starting…" : "Start thread"}
      </button>
    </form>
  );
}
