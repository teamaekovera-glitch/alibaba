/**
 * Filterable audit log viewer (spec: administration — "Audit trail viewer
 * (org-filterable)"). Staff-only read over the append-only AuditLog with
 * deterministic ordering (newest first, id tiebreak). AuditLog deliberately
 * stores actorUserId without a User relation (informational, survives user
 * deletion), so actor emails are resolved in a follow-up read for display.
 */
import { assertCan, type AuthContext } from "@packsource/core";
import { db } from "@/lib/db";

export interface AuditLogFilters {
  orgId?: string;
  /** Exact action (e.g. "review.moderate"). */
  action?: string;
  /** Exact entity type (e.g. "Review"). */
  entityType?: string;
  actorUserId?: string;
  /** Inclusive date bounds on the event time. */
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditViewRow {
  id: string;
  action: string;
  actorUserId: string | null;
  actorType: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export interface AuditLogPage {
  rows: AuditViewRow[];
  /** Actor id -> email (null when the user row no longer exists). */
  actorEmails: Record<string, string | null>;
}

export async function auditEvents(auth: AuthContext, filters: AuditLogFilters = {}) {
  assertCan(auth.role, "admin:access");
  return db.auditLog.findMany({
    where: {
      ...(filters.orgId ? { orgId: filters.orgId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: filters.limit,
    skip: filters.offset,
  });
}

/**
 * The viewer's read: URL-string filters (actor email, action prefix, entity
 * type, date bounds) -> the newest matching rows plus display emails.
 */
export async function auditLogPage(
  auth: AuthContext,
  filters: {
    actorEmail?: string;
    actionPrefix?: string;
    entity?: string;
    from?: string;
    to?: string;
  } = {},
): Promise<AuditLogPage> {
  assertCan(auth.role, "admin:access");

  let actorUserId: string | undefined;
  if (filters.actorEmail?.trim()) {
    const user = await db.user.findFirst({
      where: { email: filters.actorEmail.trim() },
      select: { id: true },
    });
    actorUserId = user?.id ?? "no-such-user"; // explicit empty result, not an unfiltered dump
  }

  const toDate = (value: string | undefined, endOfDay: boolean) => {
    if (!value?.trim()) {
      return undefined;
    }
    const parsed = new Date(`${value.trim()}${endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };

  const rows = await auditEvents(auth, {
    actorUserId,
    ...(filters.entity?.trim() ? { entityType: filters.entity.trim() } : {}),
    from: toDate(filters.from, false),
    to: toDate(filters.to, true),
    limit: 200,
  });

  // Partial action strings filter post-query (startsWith semantics).
  const filtered = filters.actionPrefix?.trim()
    ? rows.filter((row) => row.action.startsWith(filters.actionPrefix!.trim()))
    : rows;

  const actorIds = [...new Set(filtered.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, email: true },
      })
    : [];
  const actorEmails = Object.fromEntries(
    actorIds.map((id) => [id, actors.find((actor) => actor.id === id)?.email ?? null]),
  );

  return {
    rows: filtered.map((row) => ({
      id: row.id,
      action: row.action,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before,
      after: row.after,
      createdAt: row.createdAt,
    })),
    actorEmails,
  };
}

/** Distinct actions present in the trail — populates the filter dropdown. */
export async function auditActions(auth: AuthContext): Promise<string[]> {
  assertCan(auth.role, "admin:access");
  const rows = await db.auditLog.findMany({
    distinct: ["action"],
    orderBy: { action: "asc" as const },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}
