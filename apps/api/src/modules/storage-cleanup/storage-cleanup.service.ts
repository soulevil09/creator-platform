// =============================================================================
// Storage hygiene sweep (Session 09).
//
// Two earlier sessions logically deleted things and left the bytes behind:
// Session 04's soft-deleted `Content` (a `deletedAt` tombstone) and Session
// 08's expired `GenerationJob` images (`expiresAt` in the past). Both are
// unwatermarked originals sitting in the bucket with nothing pointing at them
// but a `storageKey` column. This sweep deletes those objects and then nulls
// the key, so:
//
//   * a re-run is a fast no-op — the query excludes `storageKey IS NULL`, so
//     nothing already purged is even read again, let alone re-deleted;
//   * "storageKey is never exposed" becomes true of the database at rest, not
//     only of the API responses — a purged row holds no key to leak.
//
// Shape follows the Session 06.5 renewal sweep: idempotent by query, bounded
// batches over a cursor (the `GET /api/generations` pattern), no long-lived
// transaction, one summary AuditLog row per run with counts only. Nothing in
// here reads a key into any return value — the summary carries counts and,
// for failures, row ids.
// =============================================================================
import type { StorageCleanupRunSummary } from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';

/**
 * Rows fetched per query. 100 keeps each page's provider calls to a few
 * seconds and its memory to a few kilobytes of ids/keys, so a large backlog
 * is many short pages rather than one long scan holding the event loop.
 */
export const CLEANUP_BATCH_SIZE = 100;

/** Failed row ids kept on the audit row — enough to investigate, not a dump. */
const MAX_AUDITED_FAILURES = 50;

export interface StorageCleanupServiceDeps {
  prisma: PrismaClient;
  storage: StorageClient;
  /** Bucket the objects live in (from STORAGE_BUCKET). */
  bucket: string;
}

/** The two columns the sweep needs from either table. */
interface PurgeableRow {
  id: string;
  storageKey: string | null;
}

interface Tally {
  deleted: number;
  skipped: number;
  failed: number;
  failedIds: string[];
}

export function createStorageCleanupService({
  prisma,
  storage,
  bucket,
}: StorageCleanupServiceDeps) {
  /**
   * Delete one row's object, then claim the row by nulling its key with a
   * compare-and-set on the key we just deleted. Delete-then-null is the safe
   * order: a crash in between leaves a key pointing at a missing object, which
   * the next run deletes again (S3 DeleteObject on a missing key is a no-op)
   * and then nulls. Null-then-delete would leave an orphan nothing can find.
   *
   * The CAS matters when two runs overlap (the workflow has a concurrency
   * guard, but a manual dispatch can race the schedule): whichever run's
   * `updateMany` matches zero rows lost, and counts the row as skipped rather
   * than double-counting a delete.
   */
  async function purge(
    row: PurgeableRow,
    claim: (id: string, key: string) => Promise<{ count: number }>,
    tally: Tally,
  ): Promise<void> {
    // Read the key once: the CAS below must compare against the key we
    // actually deleted, whatever the row looks like by then.
    const key = row.storageKey;
    if (key === null) {
      tally.skipped += 1;
      return;
    }
    try {
      await storage.deleteFile(bucket, key);
    } catch {
      // Key stays on the row, so tomorrow's run retries it. The id (never the
      // key) goes on the audit row.
      tally.failed += 1;
      if (tally.failedIds.length < MAX_AUDITED_FAILURES) tally.failedIds.push(row.id);
      return;
    }
    const claimed = await claim(row.id, key);
    if (claimed.count === 0) {
      tally.skipped += 1;
      return;
    }
    tally.deleted += 1;
  }

  /**
   * Walk one table in id-ordered pages of CLEANUP_BATCH_SIZE. Cursor-based over
   * the id rather than offset-based: rows leave the filtered set as their keys
   * are nulled, and an offset would skip over the survivors. The cursor is the
   * last id of the previous page, exactly as the generation gallery read
   * threads `nextCursor`; it is applied as `id > cursor` rather than Prisma's
   * `cursor: { id }` because the cursor row itself has just left the filtered
   * set (its key is now null) — a keyset predicate says "everything after it"
   * with no dependence on how the engine positions a cursor that no longer
   * matches the `where`.
   */
  async function sweep(
    fetchPage: (cursor: string | null) => Promise<PurgeableRow[]>,
    claim: (id: string, key: string) => Promise<{ count: number }>,
    tally: Tally,
  ): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const page = await fetchPage(cursor);
      for (const row of page) {
        await purge(row, claim, tally);
      }
      if (page.length < CLEANUP_BATCH_SIZE) return;
      cursor = page[page.length - 1].id;
    }
  }

  return {
    /**
     * One full sweep over both orphan sources. Returns aggregate counts only.
     * `now` is injectable so a test can pin "expired" without sleeping.
     */
    async run(now: Date = new Date()): Promise<StorageCleanupRunSummary> {
      const tally: Tally = { deleted: 0, skipped: 0, failed: 0, failedIds: [] };

      // 1. Soft-deleted Content (Session 04 gap).
      await sweep(
        (cursor) =>
          prisma.content.findMany({
            where: {
              deletedAt: { not: null },
              storageKey: { not: null },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: 'asc' },
            take: CLEANUP_BATCH_SIZE,
            select: { id: true, storageKey: true },
          }),
        (id, storageKey) =>
          prisma.content.updateMany({ where: { id, storageKey }, data: { storageKey: null } }),
        tally,
      );

      // 2. Expired COMPLETED GenerationJobs (Session 08 gap). The row itself
      //    stays — the gallery still lists the job as expired — only the
      //    object and the key go.
      await sweep(
        (cursor) =>
          prisma.generationJob.findMany({
            where: {
              status: 'COMPLETED',
              expiresAt: { lte: now },
              storageKey: { not: null },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: 'asc' },
            take: CLEANUP_BATCH_SIZE,
            select: { id: true, storageKey: true },
          }),
        (id, storageKey) =>
          prisma.generationJob.updateMany({
            where: { id, storageKey },
            data: { storageKey: null },
          }),
        tally,
      );

      const summary: StorageCleanupRunSummary = {
        deleted: tally.deleted,
        skipped: tally.skipped,
        failed: tally.failed,
      };

      // Same shape as `payout.run_completed` / `subscription.renewal_run_completed`.
      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'storage.cleanup_run_completed',
          entity: 'StorageCleanupRun',
          entityId: `run_${now.toISOString()}`,
          metadata: { ...summary, failedIds: tally.failedIds },
        },
      });

      return summary;
    },
  };
}

export type StorageCleanupService = ReturnType<typeof createStorageCleanupService>;
