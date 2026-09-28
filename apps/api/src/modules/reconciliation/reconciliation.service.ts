// =============================================================================
// Reconciliation sweep (Session 12, D6).
//
// Two "stuck" states earlier sessions deliberately left for a sweeper:
//
//   1. Stale PENDING GenerationJobs (Session 08). A crash between the credit
//      debit and the provider's answer leaves a PENDING row: the subscriber's
//      credits are gone and the one-in-flight partial unique index locks them
//      out of generating ever again. Past `GENERATION_STALE_AFTER_MS` the row
//      cannot belong to a live request any more (that bound is > the request
//      timeout — see env.ts), so the sweep FAILs it and refunds exactly the
//      stored `creditsCost`, in one transaction, behind the same compare-and-
//      set on PENDING that the live failure path uses. Freeing the slot falls
//      out of the status change.
//
//   2. Stale PENDING/PROCESSING Payouts (Session 06). The IPN that would
//      settle them never arrived. Paxum's status-query API is unverified, so
//      guessing an outcome is not allowed: the sweep changes nothing and
//      writes one `payout.stale_detected` audit row per payout per UTC day for
//      a human to act on. The row id is derived from (payout, day), so the
//      database's primary key — not a read-then-write check — is what makes a
//      second flag the same day impossible, even for two overlapping runs.
//
// Same shape as the Session 09 storage sweep: keyset pages of 100 walked by
// `id > cursor`, `select` of the few columns needed, no long transaction, and
// one `reconciliation.run_completed` audit row with counts only. No prompt
// text, anchor, email or provider payload is read, let alone written.
// =============================================================================
import type { ReconciliationRunSummary } from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { WalletService } from '../wallet/wallet.service.js';

/** Rows fetched per query — identical bound to the storage cleanup sweep. */
export const RECONCILIATION_BATCH_SIZE = 100;

/** Payout states that are waiting on the provider. COMPLETED/FAILED are settled. */
const UNSETTLED_PAYOUT_STATUSES = ['PENDING', 'PROCESSING'] as const;

const HOUR_MS = 60 * 60 * 1000;

export interface ReconciliationServiceDeps {
  prisma: PrismaClient;
  /** Session 05's wallet — the only way credits move. */
  wallet: WalletService;
  /** `GENERATION_STALE_AFTER_MS` (default 2 × `GENERATION_TIMEOUT_MS`). */
  generationStaleAfterMs: number;
  /** `PAYOUT_STALE_AFTER_HOURS` (default 72). */
  payoutStaleAfterHours: number;
}

/** `2026-09-27` for the UTC day containing `now` — the flag's idempotency key. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Id of the one stale flag a payout may get on a given UTC day. */
export function staleFlagId(payoutId: string, now: Date): string {
  return `payout_stale_${payoutId}_${utcDay(now)}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

export function createReconciliationService({
  prisma,
  wallet,
  generationStaleAfterMs,
  payoutStaleAfterHours,
}: ReconciliationServiceDeps) {
  /**
   * Walk a filtered set in id order, a page at a time. `id > cursor` rather
   * than an offset: reconciled rows leave the filtered set as they go, and an
   * offset would skip the survivors (the Session 09 reasoning, verbatim).
   */
  async function walk<T extends { id: string }>(
    fetchPage: (cursor: string | null) => Promise<T[]>,
    visit: (row: T) => Promise<void>,
  ): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const page = await fetchPage(cursor);
      for (const row of page) await visit(row);
      if (page.length < RECONCILIATION_BATCH_SIZE) return;
      cursor = page[page.length - 1].id;
    }
  }

  /**
   * FAIL + refund one stale job, atomically. Returns false when the CAS lost
   * (another run, or the live request, settled it first) — then nothing at
   * all was written.
   */
  async function reconcileGeneration(job: {
    id: string;
    subscriberId: string;
    creditsCost: number;
  }): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.generationJob.updateMany({
        where: { id: job.id, status: 'PENDING' },
        data: { status: 'FAILED', errorMessage: 'reconciled_stale' },
      });
      if (claimed.count === 0) return false;

      // The stored cost, never the current catalog price: the subscriber gets
      // back exactly what was debited, whatever the preset costs today.
      if (job.creditsCost > 0) {
        await wallet.addCredits(
          job.subscriberId,
          job.creditsCost,
          {
            reason: 'ai_generation_refund',
            actorId: null,
            relatedEntity: 'GenerationJob',
            relatedEntityId: job.id,
          },
          tx,
        );
      }
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'generation.reconciled_stale',
          entity: 'GenerationJob',
          entityId: job.id,
          metadata: { jobId: job.id, creditsRefunded: job.creditsCost },
        },
      });
      return true;
    });
  }

  /** Write today's flag for one payout; false if it already has one. */
  async function flagStalePayout(
    payout: { id: string; status: string; createdAt: Date },
    now: Date,
  ): Promise<boolean> {
    try {
      await prisma.auditLog.create({
        data: {
          id: staleFlagId(payout.id, now),
          actorId: null,
          action: 'payout.stale_detected',
          entity: 'Payout',
          entityId: payout.id,
          metadata: {
            payoutId: payout.id,
            status: payout.status,
            ageHours: Math.floor((now.getTime() - payout.createdAt.getTime()) / HOUR_MS),
          },
        },
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  return {
    /** One full sweep. `now` is injectable so tests pin "stale" without sleeping. */
    async run(now: Date = new Date()): Promise<ReconciliationRunSummary> {
      const summary: ReconciliationRunSummary = {
        generationsReconciled: 0,
        generationsSkipped: 0,
        stalePayoutsFlagged: 0,
      };

      // ── Pass 1 — stale generations ──────────────────────────────────────
      const generationCutoff = new Date(now.getTime() - generationStaleAfterMs);
      await walk(
        (cursor) =>
          prisma.generationJob.findMany({
            where: {
              status: 'PENDING',
              createdAt: { lt: generationCutoff },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: 'asc' },
            take: RECONCILIATION_BATCH_SIZE,
            select: { id: true, subscriberId: true, creditsCost: true },
          }),
        async (job) => {
          if (await reconcileGeneration(job)) summary.generationsReconciled += 1;
          else summary.generationsSkipped += 1;
        },
      );

      // ── Pass 2 — stale payouts (flag only) ──────────────────────────────
      const payoutCutoff = new Date(now.getTime() - payoutStaleAfterHours * HOUR_MS);
      await walk(
        (cursor) =>
          prisma.payout.findMany({
            where: {
              status: { in: [...UNSETTLED_PAYOUT_STATUSES] },
              createdAt: { lt: payoutCutoff },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: 'asc' },
            take: RECONCILIATION_BATCH_SIZE,
            select: { id: true, status: true, createdAt: true },
          }),
        async (payout) => {
          if (await flagStalePayout(payout, now)) summary.stalePayoutsFlagged += 1;
        },
      );

      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'reconciliation.run_completed',
          entity: 'ReconciliationRun',
          entityId: `run_${now.toISOString()}`,
          metadata: { ...summary },
        },
      });

      return summary;
    },
  };
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>;
