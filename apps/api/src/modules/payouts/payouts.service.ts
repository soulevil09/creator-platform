// =============================================================================
// Payouts business logic: what a model is owed, and the weekly run that pays it.
//
// ── The balance is derived, never stored ────────────────────────────────────
// A model's payable balance is always
//
//     SELECT SUM("modelShareCents")
//       FROM "PaymentTransaction"
//      WHERE "modelId" = $1 AND "payoutId" IS NULL
//        AND type = 'SUBSCRIPTION' AND status = 'CONFIRMED'
//
// and never a separately mutable counter. This is the same ledger-over-counter
// choice as Session 05's credit wallet: a counter can drift from the rows that
// justify it, and reconciling a drifted financial counter after the fact is not
// something a weekly cron job can do. Paying a model is therefore a *claim* —
// stamping `payoutId` onto the rows — not a decrement.
//
// ── Claiming is compare-and-set ─────────────────────────────────────────────
// The claim is `updateMany({ where: { id: { in: ids }, payoutId: null } })`
// inside the same `$transaction` that creates the `Payout`. If the matched
// count differs from what we selected, another run claimed some rows in
// between: the whole transaction aborts and nothing is double-included. Same
// pattern as the payment webhook's conditional confirm — the database
// arbitrates, not application logic.
//
// ── Failure releases the claim ──────────────────────────────────────────────
// If the provider rejects the batch, the `Payout` goes FAILED and every
// attached transaction's `payoutId` is reset to null in one transaction, so the
// earnings simply reappear in next week's balance. There is no state in which
// money is claimed but unpayable.
//
// ── Where the money goes ────────────────────────────────────────────────────
// The recipient address is `ModelProfile.payoutEmail`, never `User.email`:
// Paxum pays into a personal Paxum account whose email need not match the
// platform login. A model who has not set one is *skipped* by a run — nothing
// claimed, balance untouched, an audit entry written — exactly like a model
// whose account has vanished. Guessing an address would misroute real money.
//
// ── Scope ───────────────────────────────────────────────────────────────────
// Only SUBSCRIPTION revenue is shared here. Credit packs are a wallet-wide
// balance with no per-model attribution until AI generation ships (Session 08),
// so there is nothing honest to split yet — see CLAUDE.md.
// =============================================================================
import { createId } from '@paralleldrive/cuid2';
import {
  PAYOUT_PERIOD_DAYS,
  type Currency,
  type PayoutBalanceResponse,
  type PayoutDetailResponse,
  type PayoutEmailResponse,
  type PayoutListItem,
  type PayoutListResponse,
  type PayoutProviderName,
  type PayoutRecordStatus,
  type PayoutRunSummary,
} from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { PrismaTransactionClient } from '../wallet/wallet.service.js';
import type { WebhookHeaders } from '../payments/provider.interface.js';
import type { IPayoutProvider, NormalizedPayoutEvent } from './provider.interface.js';

/** Typed error carrying the HTTP status the route should answer with. */
export class PayoutError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

/**
 * Raised inside the claim transaction when another run got there first. Never
 * surfaces to a caller — it aborts the transaction, and the model is simply
 * counted as failed for this run and picked up by the next one.
 */
class PayoutClaimConflictError extends Error {
  constructor(modelId: string) {
    super(`Payout claim for model ${modelId} lost a race with a concurrent run`);
    this.name = 'PayoutClaimConflictError';
  }
}

/**
 * How many models are handed to the provider at once. Not sequential (one slow
 * Paxum call would stall the whole run) and not unbounded (a thousand models
 * would open a thousand sockets and trip the provider's own rate limits).
 */
const RUN_CHUNK_SIZE = 10;

/** Only these rows are payable revenue. */
const PAYABLE_WHERE = {
  type: 'SUBSCRIPTION',
  status: 'CONFIRMED',
  payoutId: null,
} as const;

export interface PayoutsServiceDeps {
  prisma: PrismaClient;
  /** Injected so tests can supply a stub adapter without touching env. */
  getProvider: () => IPayoutProvider;
  /** Minimum payable balance, minor units. */
  minThresholdCents: number;
  /** Currency Paxum settles in, used when claimed rows disagree. */
  payoutCurrency: Currency;
}

/** What one model's slot in a run did. */
type ModelOutcome =
  | { result: 'processed'; amountCents: number }
  | { result: 'skipped' }
  | { result: 'failed' };

function toListItem(row: {
  id: string;
  modelId: string;
  amountCents: number;
  currency: string;
  status: string;
  provider: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
}): PayoutListItem {
  return {
    payoutId: row.id,
    modelId: row.modelId,
    amountCents: row.amountCents,
    currency: row.currency as Currency,
    status: row.status as PayoutRecordStatus,
    provider: row.provider as PayoutProviderName,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    failureReason: row.failureReason,
  };
}

export function createPayoutsService({
  prisma,
  getProvider,
  minThresholdCents,
  payoutCurrency,
}: PayoutsServiceDeps) {
  /** SUM(modelShareCents) over this model's confirmed, unclaimed earnings. */
  async function availableBalance(
    modelId: string,
    client: PrismaTransactionClient = prisma,
  ): Promise<number> {
    const total = await client.paymentTransaction.aggregate({
      where: { ...PAYABLE_WHERE, modelId },
      _sum: { modelShareCents: true },
    });
    return total._sum.modelShareCents ?? 0;
  }

  /**
   * Claim one model's unpaid earnings under a fresh `Payout`, atomically.
   * Returns null when the balance is below the threshold — the rows keep
   * `payoutId = null` and roll into next week with no carry-over bookkeeping.
   */
  async function claimEarnings(
    modelId: string,
    providerName: PayoutProviderName,
    period: { start: Date; end: Date },
  ) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.paymentTransaction.findMany({
        where: { ...PAYABLE_WHERE, modelId },
        select: { id: true, modelShareCents: true, currency: true },
      });

      const amountCents = rows.reduce((sum, row) => sum + (row.modelShareCents ?? 0), 0);
      if (amountCents < minThresholdCents) return null;

      // Earnings are summed in minor units without FX conversion, so a batch
      // whose rows disagree on currency falls back to the configured settlement
      // currency. See the multi-currency Open Item in CLAUDE.md.
      const currencies = new Set(rows.map((row) => row.currency));
      const currency = (currencies.size === 1 ? [...currencies][0] : payoutCurrency) as Currency;

      const payout = await tx.payout.create({
        data: {
          modelId,
          amountCents,
          currency,
          status: 'PENDING',
          provider: providerName,
          idempotencyKey: `payout_${createId()}`,
          periodStart: period.start,
          periodEnd: period.end,
        },
      });

      // Compare-and-set: only rows still unclaimed are taken. A concurrent run
      // that grabbed any of them makes the counts disagree, and the throw rolls
      // this whole transaction back — including the Payout row above.
      const claimed = await tx.paymentTransaction.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, payoutId: null },
        data: { payoutId: payout.id },
      });
      if (claimed.count !== rows.length) {
        throw new PayoutClaimConflictError(modelId);
      }

      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'payout.created',
          entity: 'Payout',
          entityId: payout.id,
          metadata: {
            modelId,
            amountCents,
            currency,
            provider: providerName,
            transactionCount: rows.length,
            idempotencyKey: payout.idempotencyKey,
            periodStart: period.start.toISOString(),
            periodEnd: period.end.toISOString(),
          },
        },
      });

      return payout;
    });
  }

  /**
   * Release a failed payout's transactions back to the unpaid pool and audit
   * it. Split from the status transition so a caller that has *already* claimed
   * the payout atomically (the webhook) does not re-write the status through a
   * second, unguarded update.
   */
  async function releaseClaim(payoutId: string, reason: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const released = await tx.paymentTransaction.updateMany({
        where: { payoutId },
        data: { payoutId: null },
      });
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'payout.failed',
          entity: 'Payout',
          entityId: payoutId,
          metadata: { reason: reason.slice(0, 500), releasedTransactions: released.count },
        },
      });
    });
  }

  /** Mark a payout FAILED and release its transactions back to the pool. */
  async function failPayout(payoutId: string, reason: string): Promise<void> {
    await prisma.payout.update({
      where: { id: payoutId },
      // The reason is a message only: provider errors are truncated upstream
      // and never carry our API key or IPN secret.
      data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
    });
    await releaseClaim(payoutId, reason);
  }

  /** One model's slot in a run: claim → send → record. */
  async function payOneModel(
    modelId: string,
    provider: IPayoutProvider,
    period: { start: Date; end: Date },
  ): Promise<ModelOutcome> {
    const model = await prisma.user.findUnique({ where: { id: modelId } });
    if (!model || model.role !== 'MODEL') {
      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'payout.skipped_no_recipient',
          entity: 'User',
          entityId: modelId,
          metadata: { reason: 'model account missing or no longer a MODEL' },
        },
      });
      return { result: 'skipped' };
    }

    // Paxum pays into a personal Paxum account, whose email need not match the
    // platform login — so there is nothing to fall back to. A model who has
    // not set a destination is skipped: nothing is claimed, the balance stays
    // payable, and they are picked up the run after they set one.
    const profile = await prisma.modelProfile.findUnique({ where: { userId: modelId } });
    const payoutEmail = profile?.payoutEmail;
    if (!payoutEmail) {
      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'payout.skipped_no_payout_email',
          entity: 'User',
          entityId: modelId,
          metadata: { reason: 'model has not set a payout email' },
        },
      });
      return { result: 'skipped' };
    }

    let payout;
    try {
      payout = await claimEarnings(modelId, provider.name, period);
    } catch (err) {
      if (err instanceof PayoutClaimConflictError) return { result: 'failed' };
      throw err;
    }
    if (!payout) return { result: 'skipped' };

    let batch;
    try {
      batch = await provider.createPayout({
        recipients: [
          {
            modelId,
            destination: payoutEmail,
            amountCents: payout.amountCents,
            currency: payout.currency as Currency,
            correlationId: payout.idempotencyKey,
          },
        ],
        description: `Creator Platform earnings ${period.start.toISOString().slice(0, 10)} — ${period.end.toISOString().slice(0, 10)}`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown payout provider error';
      await failPayout(payout.id, reason);
      return { result: 'failed' };
    }

    const item = batch.items.find((entry) => entry.correlationId === payout.idempotencyKey);
    if (!item || item.status === 'FAILED') {
      await failPayout(payout.id, item?.failureReason ?? 'provider did not accept this payout');
      return { result: 'failed' };
    }

    // Accepted. PAID only happens with a provider that settles synchronously;
    // Paxum confirms by IPN, so the normal terminal state here is PROCESSING.
    const settled = item.status === 'PAID';
    await prisma.$transaction(async (tx) => {
      await tx.payout.update({
        where: { id: payout.id },
        data: {
          status: settled ? 'COMPLETED' : 'PROCESSING',
          providerPayoutId: item.providerPayoutId,
          ...(settled ? { completedAt: new Date() } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'payout.submitted',
          entity: 'Payout',
          entityId: payout.id,
          metadata: {
            modelId,
            provider: provider.name,
            providerBatchId: batch.providerBatchId,
            providerPayoutId: item.providerPayoutId,
            status: settled ? 'COMPLETED' : 'PROCESSING',
            amountCents: payout.amountCents,
          },
        },
      });
    });

    return { result: 'processed', amountCents: payout.amountCents };
  }

  return {
    /** GET /balance — the caller's own payable balance. */
    async getBalance(modelId: string): Promise<PayoutBalanceResponse> {
      const [availableCents, profile] = await Promise.all([
        availableBalance(modelId),
        prisma.modelProfile.findUnique({ where: { userId: modelId } }),
      ]);
      return {
        modelId,
        availableCents,
        currency: payoutCurrency,
        thresholdCents: minThresholdCents,
        eligible: availableCents >= minThresholdCents,
        // Surfaced so a UI can prompt before the model expects to be paid: an
        // unset destination means every run skips them, however large the
        // balance. The address itself is not echoed back here — this endpoint
        // answers "how much", not "to where".
        payoutEmailConfigured: Boolean(profile?.payoutEmail),
      };
    },

    /**
     * PUT /payout-email — set or change where this model's earnings are sent.
     *
     * Effectively a bank-detail change, so it is held to the same bar as the
     * financial events in Sessions 05/06: self-service only (the userId comes
     * from the JWT, never the body), and every change writes an `AuditLog` row
     * recording the transition. The UNIQUE index is what actually prevents two
     * models routing to one Paxum address; a violation surfaces as a clean 409
     * rather than a raw database error.
     */
    async setPayoutEmail(modelId: string, payoutEmail: string): Promise<PayoutEmailResponse> {
      const profile = await prisma.modelProfile.findUnique({ where: { userId: modelId } });
      if (!profile) {
        throw new PayoutError(404, 'Create your model profile before setting a payout email');
      }

      const previous = profile.payoutEmail;
      if (previous === payoutEmail) {
        // Nothing changed — don't write a misleading audit row claiming it did.
        return {
          modelId,
          payoutEmail,
          updatedAt: profile.updatedAt.toISOString(),
        };
      }

      let updated;
      try {
        updated = await prisma.modelProfile.update({
          where: { userId: modelId },
          data: { payoutEmail },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          throw new PayoutError(409, 'That payout email is already in use');
        }
        throw err;
      }

      await prisma.auditLog.create({
        data: {
          actorId: modelId,
          action: 'payout.email_changed',
          entity: 'ModelProfile',
          entityId: profile.id,
          metadata: {
            modelId,
            // The audit trail is the one place this address is recorded, and
            // that is deliberate: it is what makes a misrouted payout
            // traceable. It never reaches a log line or an error message.
            previousPayoutEmail: previous,
            newPayoutEmail: payoutEmail,
          },
        },
      });

      return {
        modelId,
        payoutEmail,
        updatedAt: updated.updatedAt.toISOString(),
      };
    },

    /**
     * POST /run — the weekly job. Models are processed in small batches via
     * `Promise.allSettled` so one slow or failing provider call neither stalls
     * the run nor takes the rest of it down.
     */
    async runPayouts(now: Date = new Date()): Promise<PayoutRunSummary> {
      const provider = getProvider();
      const period = {
        start: new Date(now.getTime() - PAYOUT_PERIOD_DAYS * 24 * 60 * 60 * 1000),
        end: now,
      };

      // One grouped query finds every model with unclaimed earnings; the
      // (modelId, payoutId) index is what keeps it cheap.
      const groups = await prisma.paymentTransaction.groupBy({
        by: ['modelId'],
        where: PAYABLE_WHERE,
        _sum: { modelShareCents: true },
      });

      const candidates = groups
        .map((group) => ({
          modelId: group.modelId,
          totalCents: group._sum.modelShareCents ?? 0,
        }))
        .filter(
          (group): group is { modelId: string; totalCents: number } => group.modelId !== null,
        );

      const summary: PayoutRunSummary = {
        processed: 0,
        skipped: 0,
        failed: 0,
        totalCents: 0,
      };

      // Below-threshold models never reach the provider: their rows keep
      // `payoutId = null` and roll into next week automatically.
      const payable = candidates.filter((group) => group.totalCents >= minThresholdCents);
      summary.skipped += candidates.length - payable.length;

      for (let i = 0; i < payable.length; i += RUN_CHUNK_SIZE) {
        const chunk = payable.slice(i, i + RUN_CHUNK_SIZE);
        const settled = await Promise.allSettled(
          chunk.map((group) => payOneModel(group.modelId, provider, period)),
        );
        for (const entry of settled) {
          if (entry.status === 'rejected') {
            summary.failed += 1;
            continue;
          }
          if (entry.value.result === 'processed') {
            summary.processed += 1;
            summary.totalCents += entry.value.amountCents;
          } else if (entry.value.result === 'skipped') {
            summary.skipped += 1;
          } else {
            summary.failed += 1;
          }
        }
      }

      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'payout.run_completed',
          entity: 'PayoutRun',
          entityId: `run_${period.end.toISOString()}`,
          metadata: {
            provider: provider.name,
            periodStart: period.start.toISOString(),
            periodEnd: period.end.toISOString(),
            thresholdCents: minThresholdCents,
            ...summary,
          },
        },
      });

      return summary;
    },

    /**
     * Ingest one payout status callback. Signature verification happens FIRST,
     * on the raw bytes, before any database access — a forged callback costs
     * one HMAC and nothing else.
     */
    async handleWebhook(rawBody: Buffer, headers: WebhookHeaders) {
      const provider = getProvider();

      if (!provider.verifyWebhookSignature(rawBody, headers)) {
        throw new PayoutError(400, 'Invalid webhook signature');
      }

      let event: NormalizedPayoutEvent;
      try {
        event = provider.parseWebhookEvent(rawBody);
      } catch {
        throw new PayoutError(400, 'Malformed webhook payload');
      }

      // Nothing to do for intermediate states — the payout stays PROCESSING.
      if (event.status === 'PENDING') {
        return { processed: false, duplicate: false, status: event.status };
      }

      const reason = `provider reported ${event.eventType}`;

      if (event.status === 'FAILED') {
        // Conditional claim: only a payout still in flight can fail, and the
        // terminal status is written by the same statement that claims it — so
        // a redelivery matches zero rows and the release below cannot run
        // twice. Same compare-and-set as the payment webhook's confirm.
        const claimed = await prisma.payout.updateMany({
          where: {
            idempotencyKey: event.correlationId,
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          data: {
            status: 'FAILED',
            providerPayoutId: event.providerPayoutId,
            failureReason: reason.slice(0, 500),
          },
        });
        if (claimed.count === 0) {
          return { processed: false, duplicate: true, status: event.status };
        }
        const row = await prisma.payout.findUnique({
          where: { idempotencyKey: event.correlationId },
        });
        await releaseClaim(row!.id, reason);
        return { processed: true, duplicate: false, status: event.status };
      }

      // PAID — claim and complete as one unit.
      return prisma.$transaction(async (tx) => {
        const claimed = await tx.payout.updateMany({
          where: {
            idempotencyKey: event.correlationId,
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          data: {
            status: 'COMPLETED',
            providerPayoutId: event.providerPayoutId,
            completedAt: new Date(),
          },
        });

        // Zero rows means a replay or an unknown correlation id. Both answer
        // 200 with no side effects: providers retry on non-2xx, and retrying
        // cannot change either outcome.
        if (claimed.count === 0) {
          return { processed: false, duplicate: true, status: event.status };
        }

        const row = await tx.payout.findUnique({
          where: { idempotencyKey: event.correlationId },
        });
        await tx.auditLog.create({
          data: {
            actorId: null,
            action: 'payout.completed',
            entity: 'Payout',
            entityId: row?.id ?? event.correlationId,
            metadata: {
              provider: event.provider,
              eventType: event.eventType,
              providerPayoutId: event.providerPayoutId,
              amountCents: row?.amountCents ?? null,
            },
          },
        });

        return { processed: true, duplicate: false, status: event.status };
      });
    },

    /** GET /api/payouts — ADMIN-only listing across all models. */
    async listPayouts(limit: number, offset: number): Promise<PayoutListResponse> {
      const [rows, total] = await Promise.all([
        prisma.payout.findMany({
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        prisma.payout.count(),
      ]);
      return { payouts: rows.map(toListItem), total, limit, offset };
    },

    /**
     * GET /api/payouts/:payoutId — ADMIN, or the model the payout belongs to.
     * A model reading someone else's payout gets 404, not 403: whether a given
     * payout id exists is not theirs to learn.
     */
    async getPayoutDetail(
      payoutId: string,
      requester: { userId: string; role: string },
    ): Promise<PayoutDetailResponse> {
      const row = await prisma.payout.findUnique({ where: { id: payoutId } });
      if (!row) {
        throw new PayoutError(404, 'Payout not found');
      }
      if (requester.role !== 'admin' && row.modelId !== requester.userId) {
        throw new PayoutError(404, 'Payout not found');
      }
      const transactionCount = await prisma.paymentTransaction.count({
        where: { payoutId: row.id },
      });
      return { ...toListItem(row), transactionCount };
    },
  };
}

export type PayoutsService = ReturnType<typeof createPayoutsService>;
