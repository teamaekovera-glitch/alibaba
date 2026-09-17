import { Counter } from "./counter";
import type {
  Charge,
  ChargeRequest,
  PaymentsAdapter,
  Refund,
  Transfer,
  TransferRequest,
} from "../types";

/** In-memory Stripe Connect stand-in with separate-charge-and-transfer
 * semantics: capture to the platform balance, transfer against the held
 * funds, refund from the platform balance. Deterministic IDs; moving more
 * than the held balance throws. */
export class MockPaymentsAdapter implements PaymentsAdapter {
  readonly #charges = new Map<string, LedgerCharge>();
  readonly #transfers = new Map<string, Transfer>();
  readonly #refunds = new Map<string, Refund>();
  readonly #counter = new Counter();

  async captureCharge(request: ChargeRequest): Promise<Charge> {
    if (request.amountCents <= 0) {
      throw new Error("charge amount must be positive");
    }
    const charge: LedgerCharge = {
      id: this.#counter.nextId("pi_mock"),
      amountCents: request.amountCents,
      currency: request.currency,
      status: "captured",
      transferredCents: 0,
      refundedCents: 0,
    };
    this.#charges.set(charge.id, charge);
    return { ...charge };
  }

  async transferToConnectedAccount(request: TransferRequest): Promise<Transfer> {
    const charge = this.#charges.get(request.chargeId);
    if (!charge) {
      throw new Error(`unknown charge: ${request.chargeId}`);
    }
    const heldCents = charge.amountCents - charge.transferredCents - charge.refundedCents;
    if (request.amountCents > heldCents) {
      throw new Error(
        `insufficient_held_funds: requested ${request.amountCents}, held ${heldCents} on ${request.chargeId}`,
      );
    }
    charge.transferredCents += request.amountCents;
    const transfer: Transfer = {
      id: this.#counter.nextId("tr_mock"),
      chargeId: request.chargeId,
      connectedAccountId: request.connectedAccountId,
      amountCents: request.amountCents,
      status: "paid",
    };
    this.#transfers.set(transfer.id, transfer);
    return { ...transfer };
  }

  async refundCharge(chargeId: string, amountCents?: number): Promise<Refund> {
    const charge = this.#charges.get(chargeId);
    if (!charge) {
      throw new Error(`unknown charge: ${chargeId}`);
    }
    const heldCents = charge.amountCents - charge.transferredCents - charge.refundedCents;
    const refundCents = amountCents ?? heldCents;
    if (refundCents > heldCents) {
      throw new Error(
        `insufficient_held_funds: refund ${refundCents}, held ${heldCents} on ${chargeId}`,
      );
    }
    charge.refundedCents += refundCents;
    charge.status =
      charge.amountCents - charge.transferredCents - charge.refundedCents === 0
        ? "refunded"
        : "partially_refunded";
    const refund: Refund = {
      id: this.#counter.nextId("re_mock"),
      chargeId,
      amountCents: refundCents,
    };
    this.#refunds.set(refund.id, refund);
    return { ...refund };
  }

  async getCharge(chargeId: string): Promise<Charge | undefined> {
    const charge = this.#charges.get(chargeId);
    return charge ? { ...charge } : undefined;
  }

  /** Test helper: full transfer history for a charge, in creation order. */
  transfersFor(chargeId: string): Transfer[] {
    return [...this.#transfers.values()].filter((t) => t.chargeId === chargeId);
  }
}

type LedgerCharge = Charge & { transferredCents: number; refundedCents: number };
