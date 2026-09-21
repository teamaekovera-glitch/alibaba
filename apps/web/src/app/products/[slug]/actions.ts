"use server";

import { FraudRateLimitError, PermissionDeniedError, RecordNotFoundError, ReviewError } from "@packsource/core";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { trustRepositories } from "@/lib/trust";

/**
 * Review server actions for the product page. Same contract as the orders
 * actions: handlers parse FormData and translate domain errors into
 * form-renderable messages — verified-purchase enforcement, rating
 * validation, redaction, moderation state, and fraud controls live in
 * packages/core.
 */

export type ActionState = { ok: true; message?: string } | { error: string } | null;

const DOMAIN_ERRORS = [PermissionDeniedError, RecordNotFoundError, ReviewError, FraudRateLimitError] as const;

async function withTrust(
  run: (trust: NonNullable<Awaited<ReturnType<typeof trustRepositories>>>) => Promise<unknown>,
  paths: string[],
): Promise<ActionState> {
  const session = await trustRepositories();
  if (!session) {
    redirect("/sign-in");
  }
  try {
    await run(session);
    for (const path of paths) {
      revalidatePath(path);
    }
    return { ok: true };
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

/** A rating select posts "1".."5"; empty selects mean "not given". */
function rating(form: FormData, key: string): number {
  const raw = str(form, key);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new ReviewError(`Rate ${key.replace("Rating", "")} from 1 to 5 stars`);
  }
  return value;
}

/** Buyer: leave a verified-purchase review anchored to one order line. */
export async function writeReviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const slug = str(form, "slug");
  const orderId = str(form, "orderId");
  const orderLineId = str(form, "orderLineId");
  const title = str(form, "title");
  const body = str(form, "body");
  return withTrust(
    async ({ reviews }) =>
      reviews.createReview({
        orderId,
        orderLineId,
        qualityRating: rating(form, "quality"),
        communicationRating: rating(form, "communication"),
        onTimeRating: rating(form, "onTime"),
        packagingAccuracyRating: rating(form, "packaging"),
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
      }),
    [`/products/${slug}`],
  );
}

/** Supplier: one public response to a published review. */
export async function respondToReviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const slug = str(form, "slug");
  const reviewId = str(form, "reviewId");
  const body = str(form, "body");
  return withTrust(
    async ({ reviews }) => reviews.respondToReview(reviewId, body),
    [`/products/${slug}`],
  );
}
