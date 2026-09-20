// =============================================================================
// Subscription lifecycle: renewal, grace period, cancellation.
//
// Its own module rather than more weight on `payments.service.ts`, for the same
// reason Session 06 kept `payouts/` separate: processing a single charge and
// orchestrating a subscription's life over months are distinct concerns, and
// mixing them makes both harder to reason about. What this module does NOT do
// is create charges — it calls the payments module's one
// `issueSubscriptionCharge` seam, so there remains exactly one
// `IPaymentProvider` call site for subscription revenue.
//
// ── Why `cancelAtPeriodEnd` instead of a fifth status ───────────────────────
// `status` answers one question: what access does this subscriber have right
// now. "Will this renew" is an orthogonal fact — a subscriber who cancels on
// day 2 of a 30-day period is still fully ACTIVE for 28 more days, because they
// paid for them. Folding that into `status` would mean either lying about their
// access (marking them CANCELED while they still have it) or inventing a
// CANCELING state that every access check would then have to know about. As a
// separate boolean, no existing access-control code changes at all, and the two
// terminal outcomes stay distinguishable in reporting: `CANCELED` is churn,
// `EXPIRED` is payment failure.
//
// ── Why renewal is a fresh charge ───────────────────────────────────────────
// PIX and crypto are one-shot instruments: there is no stored mandate to pull
// from, so "renewing" is issuing a new charge a few days early and asking the
// subscriber to pay it. (Woovi's Pix Automático — a BACEN recurring mandate —
// would change that for PIX subscribers specifically, but it is a separate
// retrofit; see CLAUDE.md.) That is why the sweep issues *before*
// `currentPeriodEnd` and then allows a grace window after it.
//
// ── Idempotency ─────────────────────────────────────────────────────────────
// This job moves no money by itself, so it needs none of the payout run's
// claim/rollback machinery. Each pass is idempotent by its own query:
//
//   * reminders  — skipped when a PENDING SUBSCRIPTION charge already exists
//                  for the pair, so a second run the same day issues nothing
//   * transitions — a conditional `updateMany` whose `where` includes the
//                  status being moved *from*, so re-running matches zero rows
//
// ── Access control is not this module's job ─────────────────────────────────
// `ContentAccess.expiresAt` is checked live at serve time and was written to
// expire with `currentPeriodEnd`, so a lapsed subscriber loses access on their
// own with no revocation step. The status transitions below are bookkeeping for
// admin/model reporting — they are honest, but nothing gates on them.
// =============================================================================
import {
  DEFAULT_LOCALE,
  channelForCurrency,
  isLocale,
  type MySubscriptionsResponse,
  type SubscriptionListItem,
  type SubscriptionRenewalRunSummary,
  type SubscriptionStatus,
  type SubscriptionTier,
} from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { Emailer } from '../../lib/email.js';
import type { PaymentsService } from '../payments/payments.service.js';

/** Typed error carrying the HTTP status the route should answer with. */
export class SubscriptionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionsServiceDeps {
  prisma: PrismaClient;
  emailer: Emailer;
  /**
   * The payments module's single subscription-charge seam. Injected rather
   * than imported so this module never reaches for an `IPaymentProvider`
   * itself — renewal charges and checkout charges are the same code path.
   */
  issueSubscriptionCharge: PaymentsService['issueSubscriptionCharge'];
  /** Days before `currentPeriodEnd` the renewal charge goes out. */
  reminderDays: number;
  /** Days a non-payer stays PAST_DUE after `currentPeriodEnd`. */
  gracePeriodDays: number;
}

/** Shape of the Subscription columns every read here touches. */
interface SubscriptionRow {
  id: string;
  subscriberId: string;
  modelId: string;
  tier: string;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

function toListItem(row: SubscriptionRow): SubscriptionListItem {
  return {
    subscriptionId: row.id,
    modelId: row.modelId,
    tier: row.tier as SubscriptionTier,
    status: row.status as SubscriptionStatus,
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

export function createSubscriptionsService({
  prisma,
  emailer,
  issueSubscriptionCharge,
  reminderDays,
  gracePeriodDays,
}: SubscriptionsServiceDeps) {
  /**
   * Move a set of subscriptions to a new status, audit each one, and report how
   * many actually moved. The `where` carries the status being moved *from*, so
   * the update is conditional: a second run (or a concurrent one) matches zero
   * rows rather than re-writing a transition that already happened.
   */
  async function transition(
    rows: SubscriptionRow[],
    from: SubscriptionStatus,
    to: SubscriptionStatus,
    action: string,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.id);
    const moved = await prisma.subscription.updateMany({
      where: { id: { in: ids }, status: from },
      data: { status: to },
    });
    if (moved.count === 0) return 0;

    for (const row of rows) {
      await prisma.auditLog.create({
        data: {
          // A sweep is system-triggered: there is no acting user.
          actorId: null,
          action,
          entity: 'Subscription',
          entityId: row.id,
          metadata: {
            subscriberId: row.subscriberId,
            modelId: row.modelId,
            tier: row.tier,
            from,
            to,
            currentPeriodEnd: row.currentPeriodEnd.toISOString(),
          },
        },
      });
    }
    return moved.count;
  }

  /**
   * Issue one subscription's renewal charge and email the subscriber about it.
   * Returns false when the subscription was left alone — an outstanding charge,
   * a currency no channel bills in, a missing subscriber, or a provider that
   * refused. None of those are worth failing the whole sweep over: the run is
   * daily, so anything skipped is retried tomorrow.
   */
  async function issueRenewal(row: SubscriptionRow): Promise<boolean> {
    // Idempotency for this pass: one unpaid renewal charge at a time. A second
    // run the same day finds it and does nothing, so nobody is double-charged.
    const outstanding = await prisma.paymentTransaction.findFirst({
      where: {
        userId: row.subscriberId,
        modelId: row.modelId,
        type: 'SUBSCRIPTION',
        status: 'PENDING',
      },
    });
    if (outstanding) return false;

    // Renew on the rail they actually paid on. The stored `provider` names an
    // adapter, not a channel (a `mock` adapter serving PIX reports
    // `CCBILL_MOCK`), so the currency the last confirmed charge was billed in
    // is the honest signal — and `channelForCurrency` derives it from the same
    // `CHANNEL_CURRENCY` table checkout uses, so the two cannot drift.
    const lastPaid = await prisma.paymentTransaction.findFirst({
      where: {
        userId: row.subscriberId,
        modelId: row.modelId,
        type: 'SUBSCRIPTION',
        status: 'CONFIRMED',
      },
      orderBy: { createdAt: 'desc' },
    });
    const channel = lastPaid ? channelForCurrency(lastPaid.currency) : undefined;
    if (!channel) {
      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'subscription.renewal_skipped_no_channel',
          entity: 'Subscription',
          entityId: row.id,
          metadata: {
            subscriberId: row.subscriberId,
            modelId: row.modelId,
            reason: lastPaid
              ? `no checkout channel bills in ${lastPaid.currency}`
              : 'no confirmed payment to infer a channel from',
          },
        },
      });
      return false;
    }

    const subscriber = await prisma.user.findUnique({ where: { id: row.subscriberId } });
    if (!subscriber) return false;

    let issued;
    try {
      issued = await issueSubscriptionCharge({
        userId: row.subscriberId,
        modelId: row.modelId,
        tier: row.tier as SubscriptionTier,
        provider: channel,
      });
    } catch (err) {
      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'subscription.renewal_charge_failed',
          entity: 'Subscription',
          entityId: row.id,
          metadata: {
            subscriberId: row.subscriberId,
            modelId: row.modelId,
            channel,
            // Message only — provider errors never carry our credentials.
            reason: err instanceof Error ? err.message : 'unknown error',
          },
        },
      });
      return false;
    }

    // The charge is already recorded and payable at this point, so a bounced
    // email must not undo it or abort the sweep. It is logged and moved past:
    // the subscriber can still pay from the app, and tomorrow's run finds the
    // charge outstanding and does not issue a second one.
    try {
      await emailer.sendRenewalReminderEmail(
        subscriber.email,
        {
          modelName: issued.modelDisplayName,
          tier: row.tier as SubscriptionTier,
          amountCents: issued.checkout.amount,
          currency: issued.checkout.currency,
          currentPeriodEnd: row.currentPeriodEnd,
          payment: issued.checkout.payment,
        },
        // Session 10: the reminder goes out in the language the subscriber
        // chose. The column is Zod-allowlisted on write; the read is narrowed
        // again here so a hand-edited row can only ever fall to the default.
        isLocale(subscriber.preferredLocale) ? subscriber.preferredLocale : DEFAULT_LOCALE,
      );
    } catch (err) {
      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'subscription.renewal_reminder_email_failed',
          entity: 'Subscription',
          entityId: row.id,
          metadata: {
            subscriberId: row.subscriberId,
            transactionId: issued.checkout.transactionId,
            reason: err instanceof Error ? err.message : 'unknown error',
          },
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: 'subscription.renewal_charge_issued',
        entity: 'Subscription',
        entityId: row.id,
        metadata: {
          subscriberId: row.subscriberId,
          modelId: row.modelId,
          tier: row.tier,
          channel,
          transactionId: issued.checkout.transactionId,
          idempotencyKey: issued.checkout.idempotencyKey,
          amount: issued.checkout.amount,
          currency: issued.checkout.currency,
          currentPeriodEnd: row.currentPeriodEnd.toISOString(),
        },
      },
    });
    return true;
  }

  /** Load the caller's subscription to one model, or 404. */
  async function loadOwn(subscriberId: string, modelId: string): Promise<SubscriptionRow> {
    const row = await prisma.subscription.findUnique({
      where: { subscriberId_modelId: { subscriberId, modelId } },
    });
    // Scoped by the composite key, so this can only ever be the caller's own
    // row — another subscriber's simply does not match, and reads as 404.
    if (!row) {
      throw new SubscriptionError(404, 'Subscription not found');
    }
    return row as SubscriptionRow;
  }

  return {
    /** GET /me — the caller's own subscriptions, scoped by JWT userId. */
    async listMine(subscriberId: string): Promise<MySubscriptionsResponse> {
      const rows = (await prisma.subscription.findMany({
        where: { subscriberId },
        orderBy: { currentPeriodEnd: 'desc' },
      })) as SubscriptionRow[];
      return { subscriptions: rows.map(toListItem) };
    },

    /**
     * POST /model/:modelId/cancel — stop renewing, keep what was paid for.
     *
     * Deliberately does not touch `status` or revoke any `ContentAccess`: the
     * subscriber bought this period and keeps it. Idempotent — cancelling an
     * already-cancelling subscription is a 200 no-op and writes no second audit
     * row, because nothing changed.
     */
    async cancel(subscriberId: string, modelId: string): Promise<SubscriptionListItem> {
      const row = await loadOwn(subscriberId, modelId);
      if (row.cancelAtPeriodEnd) {
        return toListItem(row);
      }

      const updated = (await prisma.subscription.update({
        where: { id: row.id },
        data: { cancelAtPeriodEnd: true },
      })) as SubscriptionRow;

      await prisma.auditLog.create({
        data: {
          actorId: subscriberId,
          action: 'subscription.cancel_requested',
          entity: 'Subscription',
          entityId: row.id,
          metadata: {
            subscriberId,
            modelId,
            status: row.status,
            // What they keep, and until when — the thing a support ticket
            // about "I cancelled but still have access" needs to settle.
            accessRetainedUntil: row.currentPeriodEnd.toISOString(),
          },
        },
      });

      return toListItem(updated);
    },

    /**
     * POST /model/:modelId/resume — changed their mind before the period ended.
     *
     * Only while still ACTIVE. Once a subscription has moved on (PAST_DUE /
     * EXPIRED / CANCELED) there is no live period to keep, so resuming would
     * mean resurrecting a lapsed row — a 409 pointing at normal checkout is a
     * simpler and more honest mental model.
     */
    async resume(subscriberId: string, modelId: string): Promise<SubscriptionListItem> {
      const row = await loadOwn(subscriberId, modelId);
      if (row.status !== 'ACTIVE') {
        throw new SubscriptionError(
          409,
          'This subscription is no longer active — subscribe again to restore access',
        );
      }
      if (!row.cancelAtPeriodEnd) {
        return toListItem(row);
      }

      const updated = (await prisma.subscription.update({
        where: { id: row.id },
        data: { cancelAtPeriodEnd: false },
      })) as SubscriptionRow;

      await prisma.auditLog.create({
        data: {
          actorId: subscriberId,
          action: 'subscription.resumed',
          entity: 'Subscription',
          entityId: row.id,
          metadata: {
            subscriberId,
            modelId,
            currentPeriodEnd: row.currentPeriodEnd.toISOString(),
          },
        },
      });

      return toListItem(updated);
    },

    /**
     * POST /renewals/run — the daily sweep. Four passes, in this order:
     *
     *   1. issue renewal charges + reminders for periods ending soon
     *   2. lapsed non-payers      ACTIVE   → PAST_DUE
     *   3. grace window elapsed   PAST_DUE → EXPIRED
     *   4. opted-out, period over ACTIVE   → CANCELED
     *
     * Pass 1 runs first on purpose: a subscription that lapsed since the last
     * run (a missed cron day, say) still gets a payable charge in the same run
     * that opens its grace period, rather than waiting a day for one.
     */
    async runRenewals(now: Date = new Date()): Promise<SubscriptionRenewalRunSummary> {
      const summary: SubscriptionRenewalRunSummary = {
        remindersIssued: 0,
        movedToPastDue: 0,
        movedToExpired: 0,
        movedToCanceled: 0,
      };

      // ── 1. Reminders ───────────────────────────────────────────────────────
      const dueSoon = (await prisma.subscription.findMany({
        where: {
          status: 'ACTIVE',
          cancelAtPeriodEnd: false,
          currentPeriodEnd: { lte: new Date(now.getTime() + reminderDays * DAY_MS) },
        },
      })) as SubscriptionRow[];

      for (const row of dueSoon) {
        if (await issueRenewal(row)) summary.remindersIssued += 1;
      }

      // ── 2. Grace period start ──────────────────────────────────────────────
      // Their ContentAccess rows expired with the period on their own; this is
      // bookkeeping so the status stops claiming access they no longer have.
      const lapsed = (await prisma.subscription.findMany({
        where: {
          status: 'ACTIVE',
          cancelAtPeriodEnd: false,
          currentPeriodEnd: { lt: now },
        },
      })) as SubscriptionRow[];
      summary.movedToPastDue = await transition(
        lapsed,
        'ACTIVE',
        'PAST_DUE',
        'subscription.past_due',
      );

      // ── 3. Grace period end ────────────────────────────────────────────────
      const graceElapsed = (await prisma.subscription.findMany({
        where: {
          status: 'PAST_DUE',
          currentPeriodEnd: { lt: new Date(now.getTime() - gracePeriodDays * DAY_MS) },
        },
      })) as SubscriptionRow[];
      summary.movedToExpired = await transition(
        graceElapsed,
        'PAST_DUE',
        'EXPIRED',
        'subscription.expired',
      );

      // ── 4. Cancellations landing ───────────────────────────────────────────
      // Straight to CANCELED, never PAST_DUE: there is nothing to retry for
      // someone who opted out, and churn must stay queryable apart from
      // payment failure.
      const cancelled = (await prisma.subscription.findMany({
        where: {
          status: 'ACTIVE',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: { lt: now },
        },
      })) as SubscriptionRow[];
      summary.movedToCanceled = await transition(
        cancelled,
        'ACTIVE',
        'CANCELED',
        'subscription.canceled',
      );

      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'subscription.renewal_run_completed',
          entity: 'SubscriptionRenewalRun',
          entityId: `run_${now.toISOString()}`,
          metadata: {
            reminderDays,
            gracePeriodDays,
            ...summary,
          },
        },
      });

      return summary;
    },
  };
}

export type SubscriptionsService = ReturnType<typeof createSubscriptionsService>;
