// =============================================================================
// Credit wallet — the platform's internal currency.
//
// Credits enter the wallet when a CREDIT_PACK payment is confirmed by a webhook
// and leave it when a subscriber spends them (AI image generation, Session 08).
// No provider is involved in a debit: spending never triggers a payment.
//
// Two invariants this module is responsible for:
//
//   1. A balance never goes negative. Debits are a *conditional* update
//      (`WHERE userId = ? AND balance >= ?`); an under-funded debit matches
//      zero rows and throws, so there is no read-then-write window and no
//      partial mutation. The migration adds a CHECK constraint as backstop.
//
//   2. No balance changes without an audit row. Both mutations write an
//      `AuditLog` entry, and both accept the caller's transaction client so
//      the credit and its audit row commit together with whatever financial
//      event caused them.
// =============================================================================
import type { PrismaClient } from '../../lib/prisma.js';

/**
 * The subset of `PrismaClient` available inside `$transaction(fn)`. Typing the
 * seam this way lets every wallet function run either standalone or as part of
 * a caller's transaction.
 */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Thrown when a debit exceeds the available balance. Nothing is mutated. */
export class InsufficientCreditsError extends Error {
  readonly status = 402;

  constructor(
    readonly userId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Insufficient credits: requested ${requested}, available ${available}`);
    this.name = 'InsufficientCreditsError';
  }
}

/** Thrown when an amount is not a positive whole number of credits. */
export class InvalidCreditAmountError extends Error {
  readonly status = 400;

  constructor(amount: number) {
    super(`Credit amount must be a positive integer (got ${amount})`);
    this.name = 'InvalidCreditAmountError';
  }
}

/** Why a wallet moved — recorded verbatim on the audit row. */
export interface CreditContext {
  /** e.g. "credit_pack_purchase", "ai_generation". */
  reason: string;
  /** Null for system/webhook-driven moves; set for user-initiated ones. */
  actorId?: string | null;
  /** Related record, for tracing a balance change back to its cause. */
  relatedEntity?: string;
  relatedEntityId?: string;
}

export interface WalletServiceDeps {
  prisma: PrismaClient;
}

function assertPositiveInt(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new InvalidCreditAmountError(amount);
  }
}

export function createWalletService({ prisma }: WalletServiceDeps) {
  return {
    /** Current balance; a user who has never transacted reads as 0. */
    async getBalance(userId: string, client: PrismaTransactionClient = prisma): Promise<number> {
      const wallet = await client.creditWallet.findUnique({ where: { userId } });
      return wallet?.balance ?? 0;
    },

    /**
     * Add credits, creating the wallet on first use. Returns the new balance.
     * Pass `client` to enlist in the caller's transaction (the webhook handler
     * does, so credit + confirmation + audit commit atomically).
     */
    async addCredits(
      userId: string,
      amount: number,
      context: CreditContext,
      client: PrismaTransactionClient = prisma,
    ): Promise<number> {
      assertPositiveInt(amount);

      const wallet = await client.creditWallet.upsert({
        where: { userId },
        update: { balance: { increment: amount } },
        create: { userId, balance: amount },
      });

      await client.auditLog.create({
        data: {
          actorId: context.actorId ?? null,
          action: 'wallet.credited',
          entity: 'CreditWallet',
          entityId: wallet.id,
          metadata: {
            userId,
            amount,
            balanceAfter: wallet.balance,
            reason: context.reason,
            ...(context.relatedEntity ? { relatedEntity: context.relatedEntity } : {}),
            ...(context.relatedEntityId ? { relatedEntityId: context.relatedEntityId } : {}),
          },
        },
      });

      return wallet.balance;
    },

    /**
     * Spend credits. The guard is in the WHERE clause, so an under-funded debit
     * updates zero rows and throws `InsufficientCreditsError` having changed
     * nothing — including no audit row, because nothing happened.
     *
     * Written generically for Session 08 (AI generation) to call.
     */
    async debitCredits(
      userId: string,
      amount: number,
      context: CreditContext = { reason: 'debit' },
      client: PrismaTransactionClient = prisma,
    ): Promise<number> {
      assertPositiveInt(amount);

      const updated = await client.creditWallet.updateMany({
        where: { userId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });

      if (updated.count === 0) {
        const wallet = await client.creditWallet.findUnique({ where: { userId } });
        throw new InsufficientCreditsError(userId, amount, wallet?.balance ?? 0);
      }

      const wallet = await client.creditWallet.findUnique({ where: { userId } });
      const balanceAfter = wallet?.balance ?? 0;

      await client.auditLog.create({
        data: {
          actorId: context.actorId ?? userId,
          action: 'wallet.debited',
          entity: 'CreditWallet',
          entityId: wallet?.id ?? userId,
          metadata: {
            userId,
            amount,
            balanceAfter,
            reason: context.reason,
            ...(context.relatedEntity ? { relatedEntity: context.relatedEntity } : {}),
            ...(context.relatedEntityId ? { relatedEntityId: context.relatedEntityId } : {}),
          },
        },
      });

      return balanceAfter;
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
