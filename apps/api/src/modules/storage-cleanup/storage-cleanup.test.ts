// =============================================================================
// Storage-hygiene sweep tests (Session 09, D4).
//
// No real database or bucket: the shared in-memory Prisma fake and a fake
// StorageClient that keeps a Set of "objects" so a delete is observable, wired
// through `buildServer` and driven over HTTP with Fastify's `inject`.
//
// The properties under test, straight from the acceptance criteria:
//   * a soft-deleted Content and an expired COMPLETED GenerationJob both get
//     their object deleted and their `storageKey` nulled
//   * a second run issues zero deletes (idempotent by query)
//   * live content, unexpired jobs and non-COMPLETED jobs are never touched
//   * a storage failure leaves the key in place for the next run and is counted
//   * pages are bounded at CLEANUP_BATCH_SIZE and walked by cursor
//   * one summary AuditLog row per run, counts only — no key anywhere in the
//     response or the audit row
//   * /cleanup/run is closed without the exact cron secret, before any work
// =============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import {
  createFakeEmailer,
  createFakePrisma,
  seedContent,
  seedGenerationJob,
  seedModel,
  type FakePrisma,
} from '../../test/fake-prisma.js';
import { CLEANUP_BATCH_SIZE } from './storage-cleanup.service.js';

const CRON_SECRET = 'test-storage-cleanup-cron-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Fakes ────────────────────────────────────────────────────────────────────
/** A bucket as a Set of keys, so "the object is gone" is a real assertion. */
function createFakeStorage(objects: Set<string>) {
  const storage: StorageClient = {
    uploadFile: vi.fn(async (_b: string, key: string) => {
      objects.add(key);
      return key;
    }),
    getSignedUrl: vi.fn(async (_b: string, key: string) => `https://signed.example/${key}`),
    getObject: vi.fn(async () => Buffer.from('RAW')),
    deleteFile: vi.fn(async (_b: string, key: string) => {
      objects.delete(key); // S3 semantics: deleting a missing key is a no-op.
    }),
  };
  return storage;
}

const fakeImages: ImageProcessor = {
  getDimensions: vi.fn(async () => ({ width: 1, height: 1 })),
  watermark: vi.fn(async () => Buffer.from('WATERMARKED')),
};

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  prisma: FakePrisma;
  storage: StorageClient;
  objects: Set<string>;
}

async function makeApp(): Promise<Harness> {
  const prisma = createFakePrisma();
  const objects = new Set<string>();
  const storage = createFakeStorage(objects);
  const app = await buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage,
    images: fakeImages,
  });
  return { app, prisma, storage, objects };
}

const runSweep = (h: Harness, secret: string = CRON_SECRET) =>
  h.app.inject({
    method: 'POST',
    url: '/api/admin/storage/cleanup/run',
    headers: { 'x-storage-cleanup-cron-secret': secret },
  });

/** Seed a row AND its object, the way an upload would have left them. */
function seedDeletedContent(h: Harness, modelId: string, overrides = {}) {
  const row = seedContent(h.prisma, {
    modelId,
    deletedAt: new Date(Date.now() - DAY_MS),
    isPublished: false,
    ...overrides,
  });
  h.objects.add(row.storageKey!);
  return row;
}

function seedExpiredJob(h: Harness, subscriberId: string, modelId: string, overrides = {}) {
  const row = seedGenerationJob(h.prisma, {
    subscriberId,
    modelId,
    status: 'COMPLETED',
    expiresAt: new Date(Date.now() - DAY_MS),
    ...overrides,
  });
  if (row.storageKey) h.objects.add(row.storageKey);
  return row;
}

const summaryRows = (h: Harness) =>
  h.prisma.__auditLogs.filter((row) => row.action === 'storage.cleanup_run_completed');

// =============================================================================
describe('POST /api/admin/storage/cleanup/run', () => {
  let h: Harness;
  const modelId = 'model_1';
  const subscriberId = 'sub_1';

  beforeEach(async () => {
    h = await makeApp();
    seedModel(h.prisma, modelId, 'model@example.com');
  });

  it('purges a soft-deleted Content and an expired GenerationJob, nulls both keys, and is a no-op on re-run', async () => {
    const content = seedDeletedContent(h, modelId);
    const job = seedExpiredJob(h, subscriberId, modelId);
    const contentKey = content.storageKey!;
    const jobKey = job.storageKey!;
    expect(h.objects.has(contentKey)).toBe(true);
    expect(h.objects.has(jobKey)).toBe(true);

    const first = await runSweep(h);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ deleted: 2, skipped: 0, failed: 0 });

    expect(h.storage.deleteFile).toHaveBeenCalledTimes(2);
    expect(h.storage.deleteFile).toHaveBeenCalledWith('test-bucket', contentKey);
    expect(h.storage.deleteFile).toHaveBeenCalledWith('test-bucket', jobKey);
    expect(h.objects.size).toBe(0);

    // Keys are nulled at rest — the row no longer knows where the bytes were.
    expect(h.prisma.__content.find((c) => c.id === content.id)!.storageKey).toBeNull();
    expect(h.prisma.__generationJobs.find((j) => j.id === job.id)!.storageKey).toBeNull();
    // The rows themselves survive: the tombstone and the expired job stay listed.
    expect(h.prisma.__content.find((c) => c.id === content.id)!.deletedAt).not.toBeNull();
    expect(h.prisma.__generationJobs.find((j) => j.id === job.id)!.status).toBe('COMPLETED');

    // Idempotent: nothing left to read, so nothing to delete.
    vi.mocked(h.storage.deleteFile).mockClear();
    const second = await runSweep(h);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ deleted: 0, skipped: 0, failed: 0 });
    expect(h.storage.deleteFile).not.toHaveBeenCalled();

    // One summary row per run, counts only.
    const summaries = summaryRows(h);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      actorId: null,
      entity: 'StorageCleanupRun',
      metadata: { deleted: 2, skipped: 0, failed: 0, failedIds: [] },
    });
    for (const res of [first, second]) {
      expect(res.body).not.toContain(contentKey);
      expect(res.body).not.toContain(jobKey);
    }
    expect(JSON.stringify(summaries)).not.toContain(contentKey);
    expect(JSON.stringify(summaries)).not.toContain(jobKey);
  });

  it('leaves live content, unexpired jobs and non-COMPLETED jobs untouched', async () => {
    const live = seedContent(h.prisma, { modelId });
    h.objects.add(live.storageKey!);
    const unexpired = seedGenerationJob(h.prisma, { subscriberId, modelId }); // +30 days
    h.objects.add(unexpired.storageKey!);
    // A FAILED job past its would-be expiry has no object; a PENDING one has
    // no key yet. Neither is COMPLETED, so neither is the sweep's business.
    seedGenerationJob(h.prisma, {
      subscriberId,
      modelId,
      status: 'FAILED',
      storageKey: null,
      expiresAt: new Date(Date.now() - DAY_MS),
    });
    seedGenerationJob(h.prisma, {
      subscriberId: 'sub_2',
      modelId,
      status: 'PENDING',
      storageKey: null,
      expiresAt: null,
    });

    const res = await runSweep(h);
    expect(res.json()).toEqual({ deleted: 0, skipped: 0, failed: 0 });
    expect(h.storage.deleteFile).not.toHaveBeenCalled();
    expect(h.prisma.__content.find((c) => c.id === live.id)!.storageKey).toBe(live.storageKey);
    expect(h.prisma.__generationJobs.find((j) => j.id === unexpired.id)!.storageKey).toBe(
      unexpired.storageKey,
    );
    expect(h.objects.size).toBe(2);
  });

  it('counts a storage failure, keeps that key for the next run, and still purges the rest', async () => {
    const good = seedDeletedContent(h, modelId);
    const bad = seedDeletedContent(h, modelId);
    const badKey = bad.storageKey!;
    vi.mocked(h.storage.deleteFile).mockImplementation(async (_b, key) => {
      if (key === badKey) throw new Error('503 Slow Down');
      h.objects.delete(key);
    });

    const first = await runSweep(h);
    expect(first.json()).toEqual({ deleted: 1, skipped: 0, failed: 1 });
    expect(h.prisma.__content.find((c) => c.id === good.id)!.storageKey).toBeNull();
    // The failed row keeps its key — it is exactly what lets tomorrow retry.
    expect(h.prisma.__content.find((c) => c.id === bad.id)!.storageKey).toBe(badKey);
    // The audit row names the failed row by id, never by key.
    const [summary] = summaryRows(h);
    expect(summary.metadata).toMatchObject({ failed: 1, failedIds: [bad.id] });
    expect(JSON.stringify(summary)).not.toContain(badKey);

    // Provider recovers → next run finishes the job.
    vi.mocked(h.storage.deleteFile).mockImplementation(async (_b, key) => {
      h.objects.delete(key);
    });
    const second = await runSweep(h);
    expect(second.json()).toEqual({ deleted: 1, skipped: 0, failed: 0 });
    expect(h.prisma.__content.find((c) => c.id === bad.id)!.storageKey).toBeNull();
    expect(h.objects.size).toBe(0);
  });

  it('walks a backlog larger than one batch by cursor, in bounded pages', async () => {
    const total = CLEANUP_BATCH_SIZE * 2 + 7;
    for (let i = 0; i < total; i++) seedDeletedContent(h, modelId);
    h.prisma.__resetCalls();

    const res = await runSweep(h);
    expect(res.json()).toEqual({ deleted: total, skipped: 0, failed: 0 });
    expect(h.objects.size).toBe(0);
    expect(h.prisma.__content.every((c) => c.storageKey === null)).toBe(true);

    // 3 pages for content (100 + 100 + 7, the short page ends the walk) and 1
    // (empty) for generation jobs. Never the whole table in one query.
    expect(h.prisma.__calls['content.findMany']).toBe(3);
    expect(h.prisma.__calls['generationJob.findMany']).toBe(1);
  });

  it('skips (never double-counts) a row another run claimed between read and update', async () => {
    const row = seedDeletedContent(h, modelId);
    const key = row.storageKey!;
    // Simulate a concurrent sweep nulling the key after our page was read but
    // before our compare-and-set: the CAS matches zero rows → skipped.
    vi.mocked(h.storage.deleteFile).mockImplementation(async (_b, k) => {
      h.objects.delete(k);
      h.prisma.__content.find((c) => c.id === row.id)!.storageKey = null;
    });

    const res = await runSweep(h);
    expect(res.json()).toEqual({ deleted: 0, skipped: 1, failed: 0 });
    expect(h.objects.has(key)).toBe(false);
  });

  describe('authentication', () => {
    it('rejects a missing, wrong, and near-miss secret alike, before any work', async () => {
      seedDeletedContent(h, modelId);

      const missing = await h.app.inject({
        method: 'POST',
        url: '/api/admin/storage/cleanup/run',
      });
      const wrong = await runSweep(h, 'not-the-secret');
      const nearMiss = await runSweep(h, `${CRON_SECRET}x`);

      for (const res of [missing, wrong, nearMiss]) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'Unauthorized' });
      }
      expect(h.storage.deleteFile).not.toHaveBeenCalled();
      expect(h.prisma.__calls['content.findMany'] ?? 0).toBe(0);
      expect(summaryRows(h)).toHaveLength(0);
      expect(h.objects.size).toBe(1);
    });

    it('does not accept a JWT in place of the secret', async () => {
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'admin-ish@example.com',
          password: 'supersecret',
          displayName: 'A',
          role: 'model',
        },
      });
      const user = h.prisma.__users.find((u) => u.email === 'admin-ish@example.com')!;
      await h.app.inject({
        method: 'GET',
        url: `/api/auth/verify-email?token=${user.verifyToken}`,
      });
      const login = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin-ish@example.com', password: 'supersecret' },
      });
      const cookie = login.cookies.find((c) => c.name === 'access_token')!.value;

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/admin/storage/cleanup/run',
        cookies: { access_token: cookie },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
