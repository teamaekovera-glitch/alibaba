import type { PrismaClient } from "@packsource/db";

/**
 * Inbound Aekovera OS attribution. A project ref identifies the Aekovera OS
 * project a buyer arrived from; capture is idempotent per (org, ref), and
 * attaching a captured ref to an order is idempotent and org-checked.
 */

export const INBOUND_REF_HEADER = "x-aekovera-project-ref";

export interface CaptureInboundRefInput {
  orgId: string;
  projectRef: string;
  /** Optional Aekovera OS brand-organization reference captured alongside. */
  brandOrgRef?: string;
}

/** Idempotent capture: re-capturing the same ref updates metadata, never duplicates. */
export async function captureInboundRef(db: PrismaClient, input: CaptureInboundRefInput) {
  const existing = await db.aekoveraProjectRef.findFirst({
    where: { orgId: input.orgId, projectRef: input.projectRef },
  });
  if (existing) {
    if (input.brandOrgRef && input.brandOrgRef !== existing.brandOrgRef) {
      return db.aekoveraProjectRef.update({
        where: { id: existing.id },
        data: { brandOrgRef: input.brandOrgRef },
      });
    }
    return existing;
  }
  return db.aekoveraProjectRef.create({
    data: {
      orgId: input.orgId,
      projectRef: input.projectRef,
      brandOrgRef: input.brandOrgRef,
    },
  });
}

/**
 * Attach a captured project ref to an order. Idempotent; refuses when the ref
 * belongs to a different org than the order (cross-org attribution leak).
 */
export async function attachRefToOrder(db: PrismaClient, orderId: string, refId: string): Promise<void> {
  const [order, ref] = await Promise.all([
    db.order.findUnique({ where: { id: orderId }, select: { id: true, orgId: true } }),
    db.aekoveraProjectRef.findUnique({ where: { id: refId }, select: { id: true, orgId: true } }),
  ]);
  if (!order) {
    throw new Error(`order not found: ${orderId}`);
  }
  if (!ref) {
    throw new Error(`project ref not found: ${refId}`);
  }
  if (ref.orgId !== order.orgId) {
    throw new Error("cannot attach a project ref from a different org");
  }
  await db.order.update({
    where: { id: orderId },
    data: { aekoveraProjectRefId: refId },
  });
}

/**
 * Parse an inbound project ref from an incoming web request. The header wins
 * over `?ref=` so first-party links cannot be spoofed by query overrides.
 */
export function parseInboundRef(request: Request): string | null {
  const header = request.headers.get(INBOUND_REF_HEADER);
  if (header && header.trim()) {
    return header.trim();
  }
  const fromQuery = new URL(request.url).searchParams.get("ref");
  return fromQuery && fromQuery.trim() ? fromQuery.trim() : null;
}
