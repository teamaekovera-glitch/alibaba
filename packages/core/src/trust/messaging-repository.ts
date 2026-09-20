/**
 * General buyer–supplier messaging (spec: "Trust & comms" — threads beyond
 * RFQ negotiation). Threads are scoped to a buyer/supplier org pair, tied
 * optionally to an order (ORDER kind) or open-ended support topics
 * (SUPPORT); message rows reuse the generic thread-scoped Message model the
 * RFQ negotiation engine mirrors into (spec: "Thread, Message").
 *
 * Contact-sharing is the same policy layer the negotiation engine enforces
 * (spec: "Contact-sharing policy"): bodies are redacted on WRITE so emails
 * and phones never reach the database, and re-redacted in the read
 * serializer so nothing leaks through rows written before the rule
 * existed. When the policy unlocks (quote accepted into an order, or the
 * buyer is a verified buyer), `contactPolicy` surfaces the counterparty's
 * org contact fields for the rendering layer — the rule itself stays pure
 * (`canShareContacts`).
 */
import { Prisma, type MessageKind, type PrismaClient, type Thread, type ThreadKind } from "@packsource/db";
import { POST_DELIVERY_ORDER_STATUSES } from "../orders/order-machine";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";
import { canShareContacts, redactContactInfo } from "../trade/redaction";
import { enforceRateLimit } from "./fraud";

/** Audit-log actions written by the messaging repository. */
export const MESSAGING_AUDIT = {
  threadCreate: "messaging.thread_create",
  message: "messaging.message",
  markRead: "messaging.mark_read",
} as const;

/** Thread kinds a user may start — RFQ threads belong to the RFQ engine. */
const STARTABLE_THREAD_KINDS: readonly ThreadKind[] = ["ORDER", "SAMPLE", "SUPPORT"];

/** Message kinds a user may post — SYSTEM is platform-only. */
const USER_MESSAGE_KINDS: readonly MessageKind[] = ["TEXT", "FILE"];

export interface MessageAttachmentInput {
  /** R2 object key from the Storage adapter (mock keys in build/test). */
  fileId: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface StartThreadInput {
  kind: Exclude<ThreadKind, "RFQ">;
  subject?: string;
  /** Required for SUPPORT threads; derived from the order for ORDER threads. */
  counterpartyOrgId?: string;
  /** ORDER threads: the order both orgs share (quote accepted into it). */
  orderId?: string;
  /** First message body — redacted before persistence. */
  body?: string;
  attachments?: MessageAttachmentInput[];
}

export interface MessagePostInput {
  body?: string;
  attachments?: MessageAttachmentInput[];
}

export interface ThreadPage {
  messages: Array<{
    id: string;
    orgId: string;
    senderUserId: string | null;
    kind: MessageKind;
    body: string | null;
    createdAt: Date;
    attachments: Array<{ id: string; fileId: string; filename: string; mimeType: string | null }>;
  }>;
  /** Opaque cursor for the next older page — undefined at the thread head. */
  nextBefore: string | undefined;
}

/** Composite keyset cursor (createdAt ISO + id) — stable when messages tie on time. */
function messageCursor(iso: string, id: string): string {
  return `${iso}::${id}`;
}

function parseMessageCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  const separator = cursor.indexOf("::");
  if (separator <= 0) {
    return undefined;
  }
  const createdAt = new Date(cursor.slice(0, separator));
  if (Number.isNaN(createdAt.getTime())) {
    return undefined;
  }
  return { createdAt, id: cursor.slice(separator + 2) };
}

/** How contact sharing resolves for a thread (spec: contact-sharing policy). */
export interface ThreadContactPolicy {
  canShareContacts: boolean;
  /** Counterparty org contact fields — null while the policy is locked. */
  contact: { orgId: string; orgName: string; billingEmail: string | null } | null;
}

/** Raised for messaging policy violations the type system cannot express. */
export class MessagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingError";
  }
}

export class MessagingRepository {
  readonly #db: PrismaClient;
  readonly #auth: AuthContext;

  constructor(db: PrismaClient, auth: AuthContext) {
    this.#db = db;
    this.#auth = auth;
  }

  #require(permission: Permission): void {
    assertCan(this.#auth.role, permission);
  }

  async #audit(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
    note?: string,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId: this.#auth.orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType,
        entityId,
        ...(note !== undefined ? { note } : {}),
      },
    });
  }

  /** Thread visible to the acting org (buyer or supplier side), or not-found. */
  async #participatingThread(
    tx: Prisma.TransactionClient | PrismaClient,
    threadId: string,
  ): Promise<Thread> {
    const found = await tx.thread.findFirst({
      where: { id: threadId, OR: [{ buyerOrgId: this.#auth.orgId }, { supplierOrgId: this.#auth.orgId }] },
    });
    if (!found) {
      throw new RecordNotFoundError("Thread", threadId);
    }
    return found;
  }

  /**
   * Start a thread and post its first message. ORDER threads derive BOTH
   * orgs from the order (the order is the shared context — an org can only
   * start a thread on an order it participates in); SUPPORT threads name the
   * counterparty explicitly and must bridge a buyer and a supplier org.
   */
  async startThread(input: StartThreadInput) {
    this.#require("message:send");
    if (!STARTABLE_THREAD_KINDS.includes(input.kind)) {
      throw new MessagingError(`thread kind ${input.kind} is reserved for the RFQ engine`);
    }
    const hasBody = typeof input.body === "string" && input.body.trim().length > 0;
    const hasAttachments = (input.attachments?.length ?? 0) > 0;
    if (!hasBody && !hasAttachments && !input.subject) {
      throw new MessagingError("a thread needs a subject or a first message");
    }

    return this.#db.$transaction(async (tx) => {
      let buyerOrgId: string;
      let supplierOrgId: string;

      if (input.orderId !== undefined) {
        const order = await tx.order.findFirst({
          where: { id: input.orderId },
          include: { subOrders: { select: { orgId: true } } },
        });
        if (!order) {
          throw new RecordNotFoundError("Order", input.orderId);
        }
        const supplierOrgIds = new Set(order.subOrders.map((sub) => sub.orgId));
        if (this.#auth.orgId === order.orgId) {
          buyerOrgId = order.orgId;
          const supplier = supplierOrgIds.values().next().value;
          if (supplier === undefined) {
            throw new MessagingError("order has no supplier to message");
          }
          supplierOrgId = supplier;
        } else if (supplierOrgIds.has(this.#auth.orgId)) {
          supplierOrgId = this.#auth.orgId;
          buyerOrgId = order.orgId;
        } else {
          // Tenancy: an order you are not part of is not yours to message on.
          throw new RecordNotFoundError("Order", input.orderId);
        }
      } else {
        if (!input.counterpartyOrgId) {
          throw new MessagingError("SUPPORT threads need a counterpartyOrgId");
        }
        const mine = await tx.organization.findUnique({ where: { id: this.#auth.orgId } });
        const theirs = await tx.organization.findUnique({ where: { id: input.counterpartyOrgId } });
        if (!theirs || theirs.deletedAt !== null) {
          throw new RecordNotFoundError("Organization", input.counterpartyOrgId);
        }
        if (mine?.type === "BUYER" && theirs.type === "SUPPLIER") {
          buyerOrgId = this.#auth.orgId;
          supplierOrgId = theirs.id;
        } else if (mine?.type === "SUPPLIER" && theirs.type === "BUYER") {
          supplierOrgId = this.#auth.orgId;
          buyerOrgId = theirs.id;
        } else {
          throw new MessagingError("threads bridge a buyer org and a supplier org");
        }
      }

      const thread = await tx.thread.create({
        data: {
          kind: input.kind,
          buyerOrgId,
          supplierOrgId,
          orderId: input.orderId,
          subject: input.subject,
          lastMessageAt: new Date(),
        },
      });

      const body = input.body ? redactContactInfo(input.body) : null;
      const message = await tx.message.create({
        data: {
          threadId: thread.id,
          orgId: this.#auth.orgId,
          senderUserId: this.#auth.userId,
          kind: hasAttachments ? "FILE" : "TEXT",
          body,
          ...(hasAttachments
            ? {
                attachments: {
                  create: (input.attachments ?? []).map((attachment) => ({
                    orgId: this.#auth.orgId,
                    fileId: attachment.fileId,
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                  })),
                },
              }
            : {}),
        },
      });

      await this.#audit(tx, MESSAGING_AUDIT.threadCreate, "Thread", thread.id);
      await this.#audit(tx, MESSAGING_AUDIT.message, "Message", message.id);
      return { thread, message };
    });
  }

  /**
   * Post a message to a thread the acting org participates in. Body text is
   * redacted on write (never persisted raw — same contract as negotiation).
   */
  async postMessage(threadId: string, input: MessagePostInput) {
    this.#require("message:send");
    const hasBody = typeof input.body === "string" && input.body.trim().length > 0;
    const hasAttachments = (input.attachments?.length ?? 0) > 0;
    if (!hasBody && !hasAttachments) {
      throw new MessagingError("a message needs a body or an attachment");
    }
    if (input.attachments?.some((attachment) => !attachment.fileId || !attachment.filename)) {
      throw new MessagingError("attachments need a fileId and filename");
    }

    return this.#db.$transaction(async (tx) => {
      const thread = await this.#participatingThread(tx, threadId);
      // Fraud control: sliding-window cap per acting org, counted atomically
      // with acceptance so rolled-back posts never consume budget.
      await enforceRateLimit(tx, "messages", this.#auth.orgId);
      const kind: MessageKind = hasAttachments ? "FILE" : "TEXT";
      if (!USER_MESSAGE_KINDS.includes(kind)) {
        throw new MessagingError(`message kind ${kind} is reserved for the platform`);
      }
      const message = await tx.message.create({
        data: {
          threadId: thread.id,
          orgId: this.#auth.orgId,
          senderUserId: this.#auth.userId,
          kind,
          body: input.body ? redactContactInfo(input.body) : null,
          ...(hasAttachments
            ? {
                attachments: {
                  create: (input.attachments ?? []).map((attachment) => ({
                    orgId: this.#auth.orgId,
                    fileId: attachment.fileId,
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                  })),
                },
              }
            : {}),
        },
      });
      await tx.thread.update({
        where: { id: thread.id },
        data: { lastMessageAt: message.createdAt },
      });
      await this.#audit(tx, MESSAGING_AUDIT.message, "Message", message.id);
      return message;
    });
  }

  /**
   * The acting org's threads, newest activity first, with unread counts and
   * a redaction-safe last-message preview. Keyset pagination on
   * `lastMessageAt` via the `before` cursor.
   */
  async listThreads(options: { limit?: number; before?: Date } = {}) {
    this.#require("message:send");
    const limit = options.limit ?? 25;
    const threads = await this.#db.thread.findMany({
      where: {
        OR: [{ buyerOrgId: this.#auth.orgId }, { supplierOrgId: this.#auth.orgId }],
        ...(options.before ? { lastMessageAt: { lt: options.before } } : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: limit + 1,
      include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const hasMore = threads.length > limit;
    const page = hasMore ? threads.slice(0, limit) : threads;

    // Unread = inbound messages newer than the org's read cursor. One query
    // from the earliest cursor on, counted per thread in memory — thread
    // counts are small and this avoids N grouped queries.
    const readStates = await this.#db.threadReadState.findMany({
      where: { orgId: this.#auth.orgId, threadId: { in: page.map((thread) => thread.id) } },
    });
    const cursors = new Map(readStates.map((state) => [state.threadId, state.lastReadAt]));
    const earliest = readStates.reduce<Date | null>(
      (min, state) => (min === null || state.lastReadAt < min ? state.lastReadAt : min),
      null,
    );
    const candidates =
      page.length === 0
        ? []
        : await this.#db.message.findMany({
            where: {
              threadId: { in: page.map((thread) => thread.id) },
              orgId: { not: this.#auth.orgId },
              ...(earliest ? { createdAt: { gt: earliest } } : {}),
            },
            select: { threadId: true, createdAt: true },
          });
    const unread = new Map<string, number>();
    for (const candidate of candidates) {
      const cursor = cursors.get(candidate.threadId);
      if (!cursor || candidate.createdAt > cursor) {
        unread.set(candidate.threadId, (unread.get(candidate.threadId) ?? 0) + 1);
      }
    }

    return {
      threads: page.map((thread) => ({
        id: thread.id,
        kind: thread.kind,
        subject: thread.subject,
        orderId: thread.orderId,
        buyerOrgId: thread.buyerOrgId,
        supplierOrgId: thread.supplierOrgId,
        lastMessageAt: thread.lastMessageAt,
        lastMessage: thread.messages[0]
          ? {
              body: thread.messages[0].body === null ? null : redactContactInfo(thread.messages[0].body),
              orgId: thread.messages[0].orgId,
              createdAt: thread.messages[0].createdAt,
            }
          : null,
        unreadCount: unread.get(thread.id) ?? 0,
      })),
      nextBefore: hasMore ? page[page.length - 1]?.lastMessageAt ?? undefined : undefined,
    };
  }

  /**
   * One page of a thread's messages, oldest-first for chat rendering. The
   * page is the newest `limit` messages ending before the composite cursor
   * — a second page loads with `before: page.nextBefore`. Read-side
   * redaction runs again (spec: the serializer cannot leak pre-policy rows).
   */
  async threadMessages(
    threadId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<ThreadPage> {
    this.#require("message:send");
    await this.#participatingThread(this.#db, threadId);
    const limit = options.limit ?? 50;
    const cursor = options.before === undefined ? undefined : parseMessageCursor(options.before);
    if (options.before !== undefined && !cursor) {
      throw new MessagingError("malformed message cursor");
    }
    const rows = await this.#db.message.findMany({
      where: {
        threadId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { attachments: { select: { id: true, fileId: true, filename: true, mimeType: true } } },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const oldest = page[page.length - 1];
    return {
      messages: page
        .map((message) => ({
          id: message.id,
          orgId: message.orgId,
          senderUserId: message.senderUserId,
          kind: message.kind,
          body: message.body === null ? null : redactContactInfo(message.body),
          createdAt: message.createdAt,
          attachments: message.attachments.map((attachment) => ({
            id: attachment.id,
            fileId: attachment.fileId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          })),
        }))
        .reverse(),
      nextBefore: hasMore && oldest ? messageCursor(oldest.createdAt.toISOString(), oldest.id) : undefined,
    };
  }

  /** Mark the acting org's read cursor on a thread (upsert). */
  async markRead(threadId: string) {
    this.#require("message:send");
    return this.#db.$transaction(async (tx) => {
      const thread = await this.#participatingThread(tx, threadId);
      const state = await tx.threadReadState.upsert({
        where: { threadId_orgId: { threadId: thread.id, orgId: this.#auth.orgId } },
        create: { threadId: thread.id, orgId: this.#auth.orgId, lastReadAt: new Date() },
        update: { lastReadAt: new Date() },
      });
      await this.#audit(tx, MESSAGING_AUDIT.markRead, "Thread", thread.id);
      return state;
    });
  }

  /** One participating thread's summary with its unread count (thread view header). */
  async threadSummary(threadId: string) {
    this.#require("message:send");
    const thread = await this.#participatingThread(this.#db, threadId);
    const readState = await this.#db.threadReadState.findUnique({
      where: { threadId_orgId: { threadId: thread.id, orgId: this.#auth.orgId } },
    });
    const [unreadCount, lastMessage] = await Promise.all([
      this.#db.message.count({
        where: {
          threadId: thread.id,
          orgId: { not: this.#auth.orgId },
          ...(readState ? { createdAt: { gt: readState.lastReadAt } } : {}),
        },
      }),
      this.#db.message.findFirst({ where: { threadId: thread.id }, orderBy: { createdAt: "desc" } }),
    ]);
    return {
      id: thread.id,
      kind: thread.kind,
      subject: thread.subject,
      orderId: thread.orderId,
      buyerOrgId: thread.buyerOrgId,
      supplierOrgId: thread.supplierOrgId,
      lastMessageAt: thread.lastMessageAt,
      lastMessage: lastMessage
        ? {
            body: lastMessage.body === null ? null : redactContactInfo(lastMessage.body),
            orgId: lastMessage.orgId,
            createdAt: lastMessage.createdAt,
          }
        : null,
      unreadCount,
    };
  }

  /**
   * Contact-sharing resolution for a thread (spec: policy unlocks at quote
   * acceptance or verified-buyer status). ORDER threads carry an accepted
   * quote by construction; for SUPPORT threads the buyer org's standing
   * decides. When unlocked, the counterparty's org-level contact fields are
   * returned for rendering — message bodies stay redacted either way.
   */
  async contactPolicy(threadId: string): Promise<ThreadContactPolicy> {
    this.#require("message:send");
    const thread = await this.#participatingThread(this.#db, threadId);
    const isBuyer = thread.buyerOrgId === this.#auth.orgId;
    const counterpartyOrgId = isBuyer ? thread.supplierOrgId : thread.buyerOrgId;
    if (counterpartyOrgId === null) {
      return { canShareContacts: false, contact: null };
    }
    const counterparty = await this.#db.organization.findUnique({ where: { id: counterpartyOrgId } });
    if (!counterparty) {
      throw new RecordNotFoundError("Organization", counterpartyOrgId);
    }

    const buyerOrgId = thread.buyerOrgId;
    const [buyerOrg, deliveredOrders] = await Promise.all([
      // Verification status lives on the org's SupplierProfile (schema); buyer
      // orgs without a profile read as unverified — same as negotiation.
      this.#db.organization.findUnique({
        where: { id: buyerOrgId },
        select: { supplierProfile: { select: { verificationStatus: true } } },
      }),
      this.#db.order.count({
        where: { orgId: buyerOrgId, status: { in: [...POST_DELIVERY_ORDER_STATUSES] } },
      }),
    ]);
    const unlocked = canShareContacts({
      quoteAccepted: thread.orderId !== null,
      buyerVerificationStatus: buyerOrg?.supplierProfile?.verificationStatus ?? null,
      buyerDeliveredOrders: deliveredOrders,
    });
    if (!unlocked) {
      return { canShareContacts: false, contact: null };
    }
    return {
      canShareContacts: true,
      contact: {
        orgId: counterparty.id,
        orgName: counterparty.name,
        billingEmail: counterparty.billingEmail,
      },
    };
  }
}
