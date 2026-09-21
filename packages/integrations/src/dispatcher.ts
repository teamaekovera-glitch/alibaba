import { createHash } from "node:crypto";
import type { PrismaClient, WebhookDelivery } from "@packsource/db";
import { isWebhookEvent, type WebhookEvent } from "./events";
import { SIGNATURE_HEADER, signatureHeader } from "./signing";
import type { WebhookTransport } from "./transport";

/**
 * Outbound webhook dispatcher for Aekovera OS.
 *
 * Delivery identity is DETERMINISTIC — a hash of (event, entityType,
 * entityId, endpoint url) — so re-dispatching the same domain event can never
 * create a second delivery row: replay is a no-op by construction. Each
 * invocation makes at most one delivery attempt per endpoint; retries ride
 * the `retryDueDeliveries` sweep with deterministic exponential backoff.
 */

export const MAX_DELIVERY_ATTEMPTS = 5;

export interface WebhookEndpoint {
  url: string;
  /** Per-endpoint HMAC secret (e.g. `whsec_...`) shared with Aekovera OS. */
  secret: string;
}

export interface DispatchInput {
  event: WebhookEvent;
  orgId?: string;
  /** Optional Aekovera OS project reference for cross-app attribution. */
  projectRef?: string;
  entityType: string;
  entityId: string;
  data?: Record<string, unknown>;
  now: Date;
  endpoints: WebhookEndpoint[];
}

export interface DispatchOutcome {
  deliveries: WebhookDelivery[];
  /** Deliveries that exhausted every attempt this invocation. */
  failed: WebhookDelivery[];
}

/** Deterministic exponential backoff: 1s, 2s, 4s, 8s… capped at 60s. */
export function backoffMs(attempt: number): number {
  return Math.min(2 ** (attempt - 1) * 1000, 60_000);
}

/** Deterministic delivery id: same event+entity+endpoint ⇒ same delivery row. */
export function deterministicDeliveryId(input: {
  event: string;
  entityType: string;
  entityId: string;
  url: string;
}): string {
  const hash = createHash("sha256")
    .update(`${input.event}|${input.entityType}|${input.entityId}|${input.url}`)
    .digest("hex")
    .slice(0, 32);
  return `whd_${hash}`;
}

export function buildPayload(input: DispatchInput, deliveryId: string): Record<string, unknown> {
  return {
    id: deliveryId,
    event: input.event,
    orgId: input.orgId ?? null,
    projectRef: input.projectRef ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    occurredAt: input.now.toISOString(),
    data: input.data ?? {},
  };
}

export async function dispatchEvent(
  db: PrismaClient,
  transport: WebhookTransport,
  input: DispatchInput,
): Promise<DispatchOutcome> {
  if (!isWebhookEvent(input.event)) {
    throw new Error(`unknown webhook event: ${input.event}`);
  }

  const deliveries: WebhookDelivery[] = [];
  const failed: WebhookDelivery[] = [];

  for (const endpoint of input.endpoints) {
    const id = deterministicDeliveryId({
      event: input.event,
      entityType: input.entityType,
      entityId: input.entityId,
      url: endpoint.url,
    });
    const existing = await db.webhookDelivery.findUnique({ where: { id } });
    if (existing) {
      // Idempotent replay: never re-deliver, never create a sibling row.
      deliveries.push(existing);
      continue;
    }

    const created = await db.webhookDelivery.create({
      data: {
        id,
        orgId: input.orgId ?? null,
        direction: "OUTBOUND",
        event: input.event,
        url: endpoint.url,
        projectRef: input.projectRef ?? null,
        payload: buildPayload(input, id) as never,
        status: "PENDING",
      },
    });

    const delivered = await attemptDelivery(db, transport, created, endpoint, input.now);
    deliveries.push(delivered);
    if (delivered.status === "FAILED") {
      failed.push(delivered);
    }
  }

  return { deliveries, failed };
}

/** One signed POST against the transport; records success, retryable failure, or exhaustion. */
export async function attemptDelivery(
  db: PrismaClient,
  transport: WebhookTransport,
  delivery: WebhookDelivery,
  endpoint: WebhookEndpoint,
  now: Date,
): Promise<WebhookDelivery> {
  const body = typeof delivery.payload === "string" ? delivery.payload : JSON.stringify(delivery.payload);
  const attempt = delivery.attempts + 1;
  let response: { ok: boolean; status: number; detail?: string };
  try {
    response = await transport.send({
      url: endpoint.url,
      headers: {
        [SIGNATURE_HEADER]: signatureHeader(endpoint.secret, Math.floor(now.getTime() / 1000), body),
      },
      body,
    });
  } catch (error) {
    response = { ok: false, status: 0, detail: error instanceof Error ? error.message : "transport error" };
  }

  if (response.ok) {
    return db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "DELIVERED",
        attempts: attempt,
        responseStatus: response.status,
        deliveredAt: now,
        lastError: null,
        nextRetryAt: null,
      },
    });
  }

  const exhausted = attempt >= MAX_DELIVERY_ATTEMPTS;
  return db.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: exhausted ? "FAILED" : "RETRYING",
      attempts: attempt,
      responseStatus: response.status,
      lastError: response.detail ?? `delivery failed with status ${response.status}`,
      nextRetryAt: exhausted ? null : new Date(now.getTime() + backoffMs(attempt)),
    },
  });
}

/**
 * Retry sweep: deliver every RETRYING delivery whose nextRetryAt has passed.
 * Endpoints are looked up by URL from the supplied registry; deliveries whose
 * endpoint is no longer registered are left untouched.
 */
export async function retryDueDeliveries(
  db: PrismaClient,
  transport: WebhookTransport,
  endpoints: Map<string, WebhookEndpoint>,
  now: Date,
): Promise<WebhookDelivery[]> {
  const due = await db.webhookDelivery.findMany({
    where: { status: "RETRYING", nextRetryAt: { lte: now } },
    orderBy: { nextRetryAt: "asc" },
  });

  const results: WebhookDelivery[] = [];
  for (const delivery of due) {
    if (!delivery.url) {
      continue; // legacy/invalid row without an endpoint URL
    }
    const endpoint = endpoints.get(delivery.url);
    if (!endpoint) {
      continue;
    }
    results.push(await attemptDelivery(db, transport, delivery, endpoint, now));
  }
  return results;
}
