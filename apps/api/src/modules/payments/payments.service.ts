// =============================================================================
// Payments business logic: checkout (money in) and webhook confirmation.
//
// Nothing here knows which provider is on the other end. It asks the factory
// for the adapter serving a channel, calls the three `IPaymentProvider`
// methods, and works in our own vocabulary (`PaymentTransaction`,
// `Subscription`, `CreditWallet`, `AuditLog`).
//
// ── Idempotency ─────────────────────────────────────────────────────────────
// Checkout mints a correlation id, stores it as `PaymentTransaction.
// idempotencyKey` (UNIQUE in Postgres), and hands it to the provider as its
// correlation/order id. The webhook echoes it back, and confirmation is a
// conditional update:
//
//     UPDATE "PaymentTransaction"
//        SET status = 'CONFIRMED'
//      WHERE "idempotencyKey" = $1 AND status = 'PENDING'
//
// The database — not application logic — decides who wins. A replayed delivery
// matches zero rows, so the wallet credit and access grants that follow simply
// never run. Two concurrent deliveries serialize on the row lock and exactly
// one proceeds. This is why the unique constraint is the source of truth: an
// application-level "have I seen this id?" check has a read-then-write window
// that two in-flight webhooks can both pass through.
//
// ── Atomicity ───────────────────────────────────────────────────────────────
// The claim, the wallet credit (or subscription upsert + ContentAccess grants),
// the revenue split, and the audit row all run inside one `prisma.$transaction`.
// There is no instant at which a transaction reads CONFIRMED but the thing it
// paid for has not been granted.
//
// ── Revenue share (Session 06) ──────────────────────────────────────────────
// A confirmed SUBSCRIPTION also stamps `modelShareCents`/`platformShareCents`
// onto the row, in the same transaction. The split is recorded at confirmation
// time rather than recomputed at payout time, so a later change to
// REVENUE_SHARE_MODEL_PCT never silently rewrites what a model was already
// owed. CREDIT_PACK rows leave both shares null: credits are a wallet-wide
// balance with no per-model attribution until Session 08.
// =============================================================================
import { createId } from '@paralleldrive/cuid2';
import {
  CHANNEL_CURRENCY,
  DEFAULT_REVENUE_SHARE_MODEL_PCT,
  SUBSCRIPTION_PERIOD_DAYS,
  SUBSCRIPTION_PLANS,
  findCreditPack,
  type CheckoutChannel,
  type CheckoutResponse,
  type ContentTier,
  type Currency,
  type PaymentChannel,
  type SubscriptionTier,
} from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { ContentService } from '../content/content.service.js';
import type { PrismaTransactionClient, WalletService } from '../wallet/wallet.service.js';
import { computeRevenueSplit } from '../payouts/revenue.js';
import {
  PaymentProviderError,
  type CreateChargeParams,
  type IPaymentProvider,
  type NormalizedPaymentEvent,
  type WebhookHeaders,
} from './provider.interface.js';

/** Typed error carrying the HTTP status the route should answer with. */
export class PaymentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/** Grant reason written on ContentAccess rows, per subscription tier. */
const GRANT_REASON: Record<SubscriptionTier, string> = {
  STANDARD: 'subscription_standard',
  PREMIUM: 'subscription_premium',
};

/** Content tiers a subscription tier unlocks. PREMIUM is a superset. */
const TIERS_UNLOCKED: Record<SubscriptionTier, ContentTier[]> = {
  STANDARD: ['STANDARD'],
  PREMIUM: ['STANDARD', 'PREMIUM'],
};

export interface PaymentsServiceDeps {
  prisma: PrismaClient;
  wallet: WalletService;
  /** Session 04's access granter, reused verbatim for subscription grants. */
  grantContentAccess: ContentService['grantContentAccess'];
  /** Injected so tests can supply a stub adapter without touching env. */
  getProvider: (channel: PaymentChannel) => IPaymentProvider;
  /**
   * Model's cut of a confirmed subscription, as a whole percent. Injected
   * (from `REVENUE_SHARE_MODEL_PCT`) rather than read here, so this module
   * stays env-free and a test can vary the split without touching process.env.
   */
  revenueShareModelPct?: number;
}

export interface SubscriptionCheckoutParams {
  userId: string;
  modelId: string;
  tier: SubscriptionTier;
  provider: CheckoutChannel;
}

export interface CreditsCheckoutParams {
  userId: string;
  packId: string;
  provider: CheckoutChannel;
}

/** What a webhook did, so the route can log it without re-deriving anything. */
export interface WebhookOutcome {
  processed: boolean;
  /** True when the event was a replay of one already applied. */
  duplicate: boolean;
  status: NormalizedPaymentEvent['status'];
  transactionId: string | null;
}

function periodEnd(from: Date = new Date()): Date {
  return new Date(from.getTime() + SUBSCRIPTION_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

export function createPaymentsService({
  prisma,
  wallet,
  grantContentAccess,
  getProvider,
  revenueShareModelPct = DEFAULT_REVENUE_SHARE_MODEL_PCT,
}: PaymentsServiceDeps) {
  /** Load the paying subscriber; they must exist and be verified. */
  async function loadCustomer(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new PaymentError(404, 'User not found');
    }
    if (!user.isVerified) {
      throw new PaymentError(403, 'Verify your email before making a payment');
    }
    return user;
  }

  /**
   * Raise a charge with the provider and record it. The PENDING row is written
   * BEFORE the provider call so a charge can never exist upstream without a
   * local record of it; if the provider then fails, the row is marked FAILED
   * (and audited) rather than left dangling as PENDING forever.
   */
  async function createCharge(args: {
    userId: string;
    channel: CheckoutChannel;
    kind: CreateChargeParams['kind'];
    amountCents: number;
    currency: Currency;
    description: string;
    creditsGranted: number | null;
    modelId: string | null;
    tier: SubscriptionTier | null;
    subscription?: CreateChargeParams['subscription'];
  }): Promise<CheckoutResponse> {
    const user = await loadCustomer(args.userId);
    const provider = getProvider(args.channel);
    // The row records whichever adapter actually serves the channel, so a
    // provider swap is visible in the data without a channel→provider table
    // that would have to be kept in sync with the factory.
    const providerName = provider.name;
    const correlationId = `${args.kind === 'subscription' ? 'sub' : 'pack'}_${createId()}`;

    const transaction = await prisma.paymentTransaction.create({
      data: {
        userId: args.userId,
        type: args.kind === 'subscription' ? 'SUBSCRIPTION' : 'CREDIT_PACK',
        provider: providerName,
        idempotencyKey: correlationId,
        amount: args.amountCents,
        currency: args.currency,
        creditsGranted: args.creditsGranted,
        modelId: args.modelId,
        tier: args.tier,
        status: 'PENDING',
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: args.userId,
        action: 'payment.charge_created',
        entity: 'PaymentTransaction',
        entityId: transaction.id,
        metadata: {
          channel: args.channel,
          provider: providerName,
          amount: args.amountCents,
          currency: args.currency,
          kind: args.kind,
          idempotencyKey: correlationId,
        },
      },
    });

    let charge;
    try {
      charge = await provider.createCharge({
        kind: args.kind,
        correlationId,
        amountCents: args.amountCents,
        currency: args.currency,
        description: args.description,
        customer: { id: user.id, email: user.email, name: user.displayName },
        subscription: args.subscription,
      });
    } catch (err) {
      await prisma.paymentTransaction.update({
        where: { id: transaction.id },
        data: { status: 'FAILED' },
      });
      await prisma.auditLog.create({
        data: {
          actorId: args.userId,
          action: 'payment.charge_failed',
          entity: 'PaymentTransaction',
          entityId: transaction.id,
          metadata: {
            idempotencyKey: correlationId,
            // Message only — provider errors never carry our credentials, and
            // the raw cause is not persisted.
            reason: err instanceof Error ? err.message : 'unknown provider error',
          },
        },
      });
      if (err instanceof PaymentProviderError) {
        throw new PaymentError(502, 'Payment provider is unavailable, please try again');
      }
      throw err;
    }

    // A provider-side recurrence handle only exists after the call succeeds.
    if (charge.providerSubscriptionId) {
      await prisma.paymentTransaction.update({
        where: { id: transaction.id },
        data: { metadata: { providerSubscriptionId: charge.providerSubscriptionId } },
      });
    }

    return {
      transactionId: transaction.id,
      provider: charge.provider,
      idempotencyKey: correlationId,
      amount: charge.amountCents,
      currency: charge.currency,
      status: 'PENDING',
      expiresAt: charge.expiresAt,
      payment: charge.payment,
    };
  }

  /** Apply a confirmed CREDIT_PACK: credit the wallet inside the same tx. */
  async function applyCreditPack(
    tx: PrismaTransactionClient,
    row: { id: string; userId: string; creditsGranted: number | null },
  ): Promise<void> {
    if (!row.creditsGranted || row.creditsGranted <= 0) {
      throw new PaymentError(500, `Transaction ${row.id} has no creditsGranted to apply`);
    }
    await wallet.addCredits(
      row.userId,
      row.creditsGranted,
      {
        reason: 'credit_pack_purchase',
        // Webhooks are system-triggered: there is no acting user.
        actorId: null,
        relatedEntity: 'PaymentTransaction',
        relatedEntityId: row.id,
      },
      tx,
    );
  }

  /**
   * Apply a confirmed SUBSCRIPTION: upsert the subscription row, then grant
   * ContentAccess (via Session 04's granter) on every published item of the
   * model whose tier this subscription unlocks. Grants expire with the period,
   * so lapsed access needs no separate revocation job.
   */
  async function applySubscription(
    tx: PrismaTransactionClient,
    row: {
      id: string;
      userId: string;
      modelId: string | null;
      tier: ContentTier | null;
      amount: number;
      provider: 'WOOVI' | 'NOWPAYMENTS' | 'CCBILL_MOCK';
    },
    providerTransactionId: string,
  ): Promise<void> {
    if (!row.modelId || !row.tier || row.tier === 'FREE') {
      throw new PaymentError(500, `Transaction ${row.id} is not a sellable subscription`);
    }
    const tier = row.tier as SubscriptionTier;
    const currentPeriodEnd = periodEnd();

    // Stamp the model/platform split on the transaction itself. This row is
    // now the only input a payout run needs: `SUM(modelShareCents) WHERE
    // payoutId IS NULL` is the model's payable balance, derived rather than
    // tracked in a counter that could drift.
    const split = computeRevenueSplit(row.amount, revenueShareModelPct);
    await tx.paymentTransaction.update({
      where: { id: row.id },
      data: {
        modelShareCents: split.modelShareCents,
        platformShareCents: split.platformShareCents,
      },
    });

    const subscription = await tx.subscription.upsert({
      where: { subscriberId_modelId: { subscriberId: row.userId, modelId: row.modelId } },
      update: {
        tier,
        status: 'ACTIVE',
        provider: row.provider,
        providerSubscriptionId: providerTransactionId,
        currentPeriodEnd,
      },
      create: {
        subscriberId: row.userId,
        modelId: row.modelId,
        tier,
        status: 'ACTIVE',
        provider: row.provider,
        providerSubscriptionId: providerTransactionId,
        currentPeriodEnd,
      },
    });

    const unlockable = await tx.content.findMany({
      where: {
        modelId: row.modelId,
        deletedAt: null,
        isPublished: true,
        tier: { in: TIERS_UNLOCKED[tier] },
      },
      select: { id: true },
    });

    for (const item of unlockable) {
      await grantContentAccess(
        {
          contentId: item.id,
          userId: row.userId,
          grantReason: GRANT_REASON[tier],
          expiresAt: currentPeriodEnd,
        },
        tx,
      );
    }

    await tx.auditLog.create({
      data: {
        actorId: null,
        action: 'subscription.activated',
        entity: 'Subscription',
        entityId: subscription.id,
        metadata: {
          subscriberId: row.userId,
          modelId: row.modelId,
          tier,
          grantedContentCount: unlockable.length,
          currentPeriodEnd: currentPeriodEnd.toISOString(),
          transactionId: row.id,
          modelShareCents: split.modelShareCents,
          platformShareCents: split.platformShareCents,
        },
      },
    });
  }

  return {
    /** POST /checkout/subscription. Price comes from the catalog, never the client. */
    async createSubscriptionCheckout(
      params: SubscriptionCheckoutParams,
    ): Promise<CheckoutResponse> {
      const model = await prisma.user.findUnique({ where: { id: params.modelId } });
      if (!model || model.role !== 'MODEL') {
        throw new PaymentError(404, 'Model not found');
      }
      if (model.id === params.userId) {
        throw new PaymentError(400, 'You cannot subscribe to yourself');
      }
      const profile = await prisma.modelProfile.findUnique({ where: { userId: model.id } });
      if (!profile) {
        throw new PaymentError(409, 'This model is not accepting subscriptions yet');
      }

      const currency = CHANNEL_CURRENCY[params.provider];
      const amountCents = SUBSCRIPTION_PLANS[params.tier].price[currency];

      return createCharge({
        userId: params.userId,
        channel: params.provider,
        kind: 'subscription',
        amountCents,
        currency,
        description: `${SUBSCRIPTION_PLANS[params.tier].label} subscription — ${model.displayName}`,
        creditsGranted: null,
        modelId: model.id,
        tier: params.tier,
        subscription: {
          modelId: model.id,
          tier: params.tier,
          intervalDays: SUBSCRIPTION_PERIOD_DAYS,
        },
      });
    },

    /** POST /checkout/credits. */
    async createCreditsCheckout(params: CreditsCheckoutParams): Promise<CheckoutResponse> {
      const pack = findCreditPack(params.packId);
      if (!pack) {
        throw new PaymentError(404, 'Credit pack not found');
      }
      const currency = CHANNEL_CURRENCY[params.provider];

      return createCharge({
        userId: params.userId,
        channel: params.provider,
        kind: 'credit_pack',
        amountCents: pack.price[currency],
        currency,
        description: `${pack.label} credit pack — ${pack.credits} credits`,
        creditsGranted: pack.credits,
        modelId: null,
        tier: null,
      });
    },

    /**
     * Ingest one provider callback. Signature verification happens FIRST, on
     * the raw bytes, before any database access — a forged or malformed
     * callback costs one HMAC and nothing else.
     */
    async handleWebhook(
      channel: PaymentChannel,
      rawBody: Buffer,
      headers: WebhookHeaders,
    ): Promise<WebhookOutcome> {
      const provider = getProvider(channel);

      if (!provider.verifyWebhookSignature(rawBody, headers)) {
        throw new PaymentError(400, 'Invalid webhook signature');
      }

      let event: NormalizedPaymentEvent;
      try {
        event = provider.parseWebhookEvent(rawBody);
      } catch {
        throw new PaymentError(400, 'Malformed webhook payload');
      }

      // Nothing to do for intermediate states — the charge stays PENDING.
      if (event.status === 'PENDING') {
        return { processed: false, duplicate: false, status: 'PENDING', transactionId: null };
      }

      if (event.status === 'FAILED') {
        const failed = await prisma.paymentTransaction.updateMany({
          where: { idempotencyKey: event.correlationId, status: 'PENDING' },
          data: { status: 'FAILED', providerTransactionId: event.providerTransactionId },
        });
        if (failed.count === 0) {
          return { processed: false, duplicate: true, status: 'FAILED', transactionId: null };
        }
        const row = await prisma.paymentTransaction.findUnique({
          where: { idempotencyKey: event.correlationId },
        });
        await prisma.auditLog.create({
          data: {
            actorId: null,
            action: 'payment.failed',
            entity: 'PaymentTransaction',
            entityId: row?.id ?? event.correlationId,
            metadata: {
              provider: event.provider,
              eventType: event.eventType,
              providerTransactionId: event.providerTransactionId,
            },
          },
        });
        return {
          processed: true,
          duplicate: false,
          status: 'FAILED',
          transactionId: row?.id ?? null,
        };
      }

      // CONFIRMED — claim, apply, and audit as one unit.
      return prisma.$transaction(async (tx) => {
        const claimed = await tx.paymentTransaction.updateMany({
          where: { idempotencyKey: event.correlationId, status: 'PENDING' },
          data: {
            status: 'CONFIRMED',
            providerTransactionId: event.providerTransactionId,
            confirmedAt: new Date(),
          },
        });

        // Zero rows means either a replay (already CONFIRMED) or an unknown
        // correlation id. Both are answered 200 with no side effects: providers
        // retry on non-2xx, and retrying will not change either outcome.
        if (claimed.count === 0) {
          return {
            processed: false,
            duplicate: true,
            status: 'CONFIRMED' as const,
            transactionId: null,
          };
        }

        const row = await tx.paymentTransaction.findUnique({
          where: { idempotencyKey: event.correlationId },
        });
        if (!row) {
          throw new PaymentError(500, 'Confirmed transaction vanished mid-transaction');
        }

        if (row.type === 'CREDIT_PACK') {
          await applyCreditPack(tx, row);
        } else {
          await applySubscription(tx, row, event.providerTransactionId);
        }

        await tx.auditLog.create({
          data: {
            actorId: null,
            action: 'payment.confirmed',
            entity: 'PaymentTransaction',
            entityId: row.id,
            metadata: {
              provider: event.provider,
              eventType: event.eventType,
              providerTransactionId: event.providerTransactionId,
              type: row.type,
              amount: row.amount,
              currency: row.currency,
            },
          },
        });

        return {
          processed: true,
          duplicate: false,
          status: 'CONFIRMED' as const,
          transactionId: row.id,
        };
      });
    },
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
