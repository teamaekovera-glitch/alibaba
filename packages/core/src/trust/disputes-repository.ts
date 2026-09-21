/**
 * Dispute lifecycle (spec: "Disputes" — buyer opens with reason/evidence,
 * supplier responds, staff resolves). Opening and resolution (with refunds
 * and the escrow handoff) live in OrderRepository via the order machine;
 * this repository owns the discussion layer between those bookends:
 * supplier/buyer responses, evidence attachments, staff review transition,
 * buyer withdrawal, and participant-scoped reads. Every mutation is
 * validated by the pure dispute machine and audited.
 */
import { Prisma, type OrderStatus, type PrismaClient } from "@packsource/db";
import { LEGAL_DISPUTE_RESOLUTIONS, orderTransition } from "../orders/order-machine";
import { assertCan, type Permission } from "../permissions";
import { RecordNotFoundError, type AuthContext } from "../repositories";
import { redactContactInfo } from "../trade/redaction";
import { disputeTransition, type DisputeEvent } from "./dispute-machine";

/** Audit-log actions written by the disputes repository. */
export const DISPUTES_AUDIT = {
  respond: "dispute.respond",
  evidence: "dispute.evidence",
  startReview: "dispute.start_review",
  withdraw: "dispute.withdraw",
} as const;

/** Business-rule violation inside the disputes domain (rendered as form copy). */
export class DisputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisputeError";
  }
}

export interface DisputeResponseView {
  id: string;
  orgId: string;
  orgName: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export class DisputesRepository {
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
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId: this.#auth.orgId,
        actorUserId: this.#auth.userId,
        actorType: "user",
        action,
        entityType,
        entityId,
        ...(after !== undefined ? { after } : {}),
      },
    });
  }

  /** The dispute plus the order's supplier legs; participant-guarded. */
  async #participatingDispute(tx: Prisma.TransactionClient | PrismaClient, disputeId: string) {
    const dispute = await tx.dispute.findUnique({
      where: { id: disputeId },
      include: { order: { include: { subOrders: { select: { orgId: true } } } } },
    });
    if (!dispute) {
      throw new RecordNotFoundError("Dispute", disputeId);
    }
    const isBuyer = dispute.orgId === this.#auth.orgId;
    const isSupplier = dispute.order.subOrders.some((sub) => sub.orgId === this.#auth.orgId);
    const isStaff = this.#auth.role === "AEKOVERA_STAFF";
    if (!isBuyer && !isSupplier && !isStaff) {
      throw new DisputeError(`organization ${this.#auth.orgId} is not a participant in dispute ${disputeId}`);
    }
    return { dispute, isBuyer, isSupplier, isStaff };
  }

  /** Apply a machine event to a dispute row inside a transaction. */
  async #transition(
    tx: Prisma.TransactionClient,
    disputeId: string,
    event: DisputeEvent,
    audit: { action: string; note?: string },
  ) {
    const dispute = await tx.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) {
      throw new RecordNotFoundError("Dispute", disputeId);
    }
    const plan = disputeTransition(dispute, event);
    if (plan.length === 0) {
      throw new DisputeError(`dispute ${disputeId} in status ${dispute.status} does not accept ${event.type}`);
    }
    const final = plan[plan.length - 1]!;
    const updated = await tx.dispute.update({
      where: { id: disputeId },
      data: { status: final.to },
    });
    await this.#audit(tx, audit.action, "Dispute", disputeId, audit.note ? { note: audit.note } : undefined);
    return { dispute: updated, selfLoop: final.from === final.to };
  }

  /** Append a discussion response (buyer opener, supplier side, or staff). */
  async respond(disputeId: string, body: string): Promise<DisputeResponseView> {
    // Discussion is comms: every participating role (buyer, supplier, staff)
    // holds message:send — order:create would lock suppliers out entirely.
    this.#require("message:send");
    if (!body.trim()) {
      throw new DisputeError("write a response first");
    }
    return this.#db.$transaction(async (tx) => {
      await this.#participatingDispute(tx, disputeId);
      const [author, org] = await Promise.all([
        tx.user.findUnique({ where: { id: this.#auth.userId }, select: { name: true } }),
        tx.organization.findUnique({ where: { id: this.#auth.orgId }, select: { name: true } }),
      ]);
      const response = await tx.disputeResponse.create({
        data: {
          disputeId,
          orgId: this.#auth.orgId,
          authorUserId: this.#auth.userId,
          body: redactContactInfo(body),
        },
      });
      await this.#transition(tx, disputeId, { type: "RESPOND", at: new Date() }, {
        action: DISPUTES_AUDIT.respond,
        note: `by org ${this.#auth.orgId}`,
      });
      return {
        id: response.id,
        orgId: this.#auth.orgId,
        orgName: org?.name ?? "organization",
        authorUserId: this.#auth.userId,
        authorName: author?.name ?? "member",
        body: response.body,
        createdAt: response.createdAt,
      };
    });
  }

  /** Attach an evidence file (buyer opener or staff) to an active dispute. */
  async attachEvidence(disputeId: string, input: { fileId: string; note?: string }) {
    // Buyer and staff attach evidence; both hold the comms permission.
    this.#require("message:send");
    return this.#db.$transaction(async (tx) => {
      const { dispute, isBuyer, isStaff } = await this.#participatingDispute(tx, disputeId);
      if (!isBuyer && !isStaff) {
        throw new DisputeError("only the disputing buyer or staff may attach evidence");
      }
      const evidence = await tx.disputeEvidence.create({
        data: {
          disputeId: dispute.id,
          orgId: this.#auth.orgId,
          fileId: input.fileId,
          note: input.note ?? null,
          uploadedByUserId: this.#auth.userId,
        },
      });
      await this.#transition(tx, disputeId, { type: "ATTACH_EVIDENCE", at: new Date() }, {
        action: DISPUTES_AUDIT.evidence,
        note: input.fileId,
      });
      return evidence;
    });
  }

  /** Staff picks the dispute up: OPEN → UNDER_REVIEW. */
  async startReview(disputeId: string) {
    this.#require("dispute:mediate");
    return this.#db.$transaction(async (tx) => {
      await this.#participatingDispute(tx, disputeId);
      const { dispute } = await this.#transition(tx, disputeId, { type: "START_REVIEW", at: new Date() }, {
        action: DISPUTES_AUDIT.startReview,
      });
      return dispute;
    });
  }

  /** Buyer withdraws an active dispute; the order resumes to its pre-dispute status. */
  async withdraw(disputeId: string) {
    // Withdrawal is a participant action; buyer and staff both hold message:send.
    this.#require("message:send");
    return this.#db.$transaction(async (tx) => {
      const { isBuyer, isStaff } = await this.#participatingDispute(tx, disputeId);
      if (!isBuyer && !isStaff) {
        throw new DisputeError("only the disputing buyer may withdraw");
      }
      const { dispute: withdrawn } = await this.#transition(tx, disputeId, { type: "WITHDRAW", at: new Date() }, {
        action: DISPUTES_AUDIT.withdraw,
      });
      // The order machine only exits DISPUTED via RESOLVE_DISPUTE, so a
      // withdrawal must also unfreeze the order — back to the status it was
      // in when the dispute froze it. Escrow release resumes from there.
      const order = await tx.order.findUnique({ where: { id: withdrawn.orderId } });
      const resume = withdrawn.preOrderStatus;
      if (order && order.status === "DISPUTED" && resume && LEGAL_DISPUTE_RESOLUTIONS.includes(resume as OrderStatus)) {
        const [plan] = orderTransition(
          {
            status: order.status,
            paymentSchedule: order.paymentSchedule,
            balancePaid: true,
            openDisputeId: null,
          },
          { type: "RESOLVE_DISPUTE", to: resume as OrderStatus, at: new Date() },
        );
        if (plan) {
          await tx.order.update({ where: { id: order.id }, data: { status: plan.to } });
        }
      }
      return withdrawn;
    });
  }

  /** Participant view: dispute + evidence + response trail, oldest first. */
  async disputeDetail(disputeId: string) {
    const { dispute } = await this.#participatingDispute(this.#db, disputeId);
    const [evidence, responses] = await Promise.all([
      this.#db.disputeEvidence.findMany({ where: { disputeId }, orderBy: { createdAt: "asc" } }),
      this.#db.disputeResponse.findMany({
        where: { disputeId },
        orderBy: { createdAt: "asc" },
        include: {
          org: { select: { name: true } },
          authorUser: { select: { name: true } },
        },
      }),
    ]);
    return {
      dispute,
      evidence,
      responses: responses.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        orgName: row.org.name,
        authorUserId: row.authorUserId,
        authorName: row.authorUser.name ?? "member",
        body: row.body,
        createdAt: row.createdAt,
      })) satisfies DisputeResponseView[],
    };
  }

  /** The acting org's disputes (buyer side), newest first. */
  async listForOrg() {
    return this.#db.dispute.findMany({
      where: { orgId: this.#auth.orgId },
      orderBy: { createdAt: "desc" },
      include: { order: { select: { id: true, status: true } } },
    });
  }
}
