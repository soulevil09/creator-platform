// =============================================================================
// Reconciliation sweep tests (Session 12, D6).
//
// Shared in-memory Prisma fake, driven over HTTP through `buildServer`, the
// same harness shape as the Session 09 storage-cleanup suite. Acceptance:
//   * a stale PENDING job → FAILED + refund of its STORED cost + slot freed
//     (a new POST /api/generations then succeeds)
//   * a fresh PENDING job is untouched
//   * a replay refunds nothing a second time; two concurrent runs refund once
//   * a stale payout gets exactly one flag per UTC day, status unchanged
//   * wrong/missing secret → 401 with zero database calls
//   * counts only in the response and the summary row; no prompt text anywhere
// =============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATION_PRESETS } from '@creator-platform/shared';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import { env } from '../../lib/env.js';
import {
  createFakeEmailer,
  createFakePrisma,
  seedGenerationJob,
  seedModel,
  seedProfile,
  seedReferenceImage,
  seedWallet,
  type FakePayout,
  type FakePrisma,
} from '../../test/fake-prisma.js';
import { MockAIProvider } from '../generation/adapters/mock.adapter.js';
import { createWalletService } from '../wallet/wallet.service.js';
import {
  RECONCILIATION_BATCH_SIZE,
  createReconciliationService,
  staleFlagId,
} from './reconciliation.service.js';

const CRON_SECRET = 'test-reconciliation-cron-secret';
const HOUR_MS = 60 * 60 * 1000;
const STALE_AGO = env.GENERATION_STALE_AFTER_MS + 60_000;
/** A prompt that must never be copied into any reconciliation output. */
const SECRET_PROMPT = 'PROMPT-TEXT-THAT-MUST-NOT-LEAK';
const PRESET = GENERATION_PRESETS[0];

// ── Fakes ────────────────────────────────────────────────────────────────────
const fakeStorage: StorageClient = {
  uploadFile: vi.fn(async (_b: string, key: string) => key),
  getSignedUrl: vi.fn(async (_b: string, key: string) => `https://signed.example/${key}`),
  getObject: vi.fn(async () => Buffer.from('RAW')),
  deleteFile: vi.fn(async () => {}),
};

const fakeImages: ImageProcessor = {
  getDimensions: vi.fn(async () => ({ width: 1, height: 1 })),
  watermark: vi.fn(async () => Buffer.from('WATERMARKED')),
};

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  prisma: FakePrisma;
}

async function makeApp(): Promise<Harness> {
  const prisma = createFakePrisma();
  const app = await buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage: fakeStorage,
    images: fakeImages,
    getAIProvider: () => new MockAIProvider(),
  });
  return { app, prisma };
}

const runSweep = (h: Harness, secret?: string) =>
  h.app.inject({
    method: 'POST',
    url: '/api/admin/reconciliation/run',
    headers: secret === undefined ? {} : { 'x-reconciliation-cron-secret': secret },
  });

/** register → verify → login; returns the access cookie and user id. */
async function loginAs(h: Harness, role: 'model' | 'subscriber', email: string) {
  await h.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'supersecret', displayName: `Test ${role}`, role },
  });
  const user = h.prisma.__users.find((u) => u.email === email)!;
  await h.app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${user.verifyToken}` });
  const login = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'supersecret' },
  });
  return { cookie: login.cookies.find((c) => c.name === 'access_token')!.value, userId: user.id };
}

function seedPendingJob(
  h: Harness,
  subscriberId: string,
  modelId: string,
  ageMs: number,
  creditsCost = 25,
) {
  return seedGenerationJob(h.prisma, {
    subscriberId,
    modelId,
    status: 'PENDING',
    storageKey: null,
    expiresAt: null,
    providerJobId: null,
    mode: 'CUSTOM',
    presetId: null,
    userPrompt: SECRET_PROMPT,
    creditsCost,
    createdAt: new Date(Date.now() - ageMs),
  });
}

function seedPayout(h: Harness, overrides: Partial<FakePayout> & { modelId: string }): FakePayout {
  const n = h.prisma.__payouts.length + 1;
  const row: FakePayout = {
    id: `po_seed_${String(n).padStart(4, '0')}`,
    amountCents: 6000,
    currency: 'BRL',
    status: 'PROCESSING',
    provider: 'PAXUM',
    providerPayoutId: `pax_${n}`,
    idempotencyKey: `payout_seed_${n}`,
    periodStart: new Date(0),
    periodEnd: new Date(),
    failureReason: null,
    createdAt: new Date(),
    completedAt: null,
    ...overrides,
  };
  h.prisma.__payouts.push(row);
  return row;
}

const balanceOf = (h: Harness, userId: string) =>
  h.prisma.__wallets.find((w) => w.userId === userId)?.balance ?? 0;
const audits = (h: Harness, action: string) =>
  h.prisma.__auditLogs.filter((row) => row.action === action);

/**
 * Count every delegate call on the fake — not only the ones it tracks itself —
 * so "zero database calls" is a real assertion.
 */
function countEveryCall(prisma: FakePrisma): () => number {
  let total = 0;
  const target = prisma as unknown as Record<string, unknown>;
  for (const [name, delegate] of Object.entries(target)) {
    if (name.startsWith('__')) continue;
    if (typeof delegate === 'function') {
      target[name] = (...args: unknown[]) => {
        total += 1;
        return (delegate as (...a: unknown[]) => unknown)(...args);
      };
      continue;
    }
    if (delegate && typeof delegate === 'object') {
      const methods = delegate as Record<string, unknown>;
      for (const [method, fn] of Object.entries(methods)) {
        if (typeof fn !== 'function') continue;
        methods[method] = (...args: unknown[]) => {
          total += 1;
          return (fn as (...a: unknown[]) => unknown)(...args);
        };
      }
    }
  }
  return () => total;
}

// =============================================================================
describe('POST /api/admin/reconciliation/run — pass 1, stale generations', () => {
  let h: Harness;
  let sub: { cookie: string; userId: string };
  let modelId: string;

  beforeEach(async () => {
    h = await makeApp();
    const model = await loginAs(h, 'model', 'model@example.com');
    modelId = model.userId;
    const profile = seedProfile(h.prisma, modelId, undefined, { aiConsent: true });
    seedReferenceImage(h.prisma, profile.id);
    sub = await loginAs(h, 'subscriber', 'sub@example.com');
    seedWallet(h.prisma, sub.userId, 100);
  });

  it('FAILs a stale job, refunds its stored cost, and frees the one-in-flight slot', async () => {
    // The stored cost (25) deliberately differs from any catalog price: the
    // refund must be what was debited, not what the preset costs today.
    const job = seedPendingJob(h, sub.userId, modelId, STALE_AGO, 25);

    // Locked out before the sweep: the partial unique index sees the PENDING row.
    const blocked = await h.app.inject({
      method: 'POST',
      url: '/api/generations',
      cookies: { access_token: sub.cookie },
      payload: { modelId, mode: 'preset', presetId: PRESET.id },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'generation_in_progress' });

    const res = await runSweep(h, CRON_SECRET);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      generationsReconciled: 1,
      generationsSkipped: 0,
      stalePayoutsFlagged: 0,
    });

    const row = h.prisma.__generationJobs.find((j) => j.id === job.id)!;
    expect(row.status).toBe('FAILED');
    expect(row.errorMessage).toBe('reconciled_stale');
    expect(balanceOf(h, sub.userId)).toBe(125);

    const [reconciled] = audits(h, 'generation.reconciled_stale');
    expect(reconciled).toMatchObject({
      entity: 'GenerationJob',
      entityId: job.id,
      metadata: { jobId: job.id, creditsRefunded: 25 },
    });
    expect(audits(h, 'wallet.credited')).toHaveLength(1);

    // Slot freed: a new generation now goes through.
    const retry = await h.app.inject({
      method: 'POST',
      url: '/api/generations',
      cookies: { access_token: sub.cookie },
      payload: { modelId, mode: 'preset', presetId: PRESET.id },
    });
    expect(retry.statusCode).toBe(201);
    expect(balanceOf(h, sub.userId)).toBe(125 - PRESET.creditsCost);

    // Nothing the sweep wrote carries the prompt text.
    const written = JSON.stringify([
      res.json(),
      audits(h, 'generation.reconciled_stale'),
      audits(h, 'reconciliation.run_completed'),
      audits(h, 'wallet.credited'),
    ]);
    expect(written).not.toContain(SECRET_PROMPT);
  });

  it('leaves a fresh PENDING job alone', async () => {
    const fresh = seedPendingJob(h, sub.userId, modelId, 5_000);

    const res = await runSweep(h, CRON_SECRET);
    expect(res.json()).toMatchObject({ generationsReconciled: 0, generationsSkipped: 0 });
    expect(h.prisma.__generationJobs.find((j) => j.id === fresh.id)!.status).toBe('PENDING');
    expect(balanceOf(h, sub.userId)).toBe(100);
    expect(audits(h, 'generation.reconciled_stale')).toHaveLength(0);
  });

  it('never touches settled jobs, however old', async () => {
    seedGenerationJob(h.prisma, {
      subscriberId: sub.userId,
      modelId,
      status: 'COMPLETED',
      createdAt: new Date(Date.now() - 10 * STALE_AGO),
    });
    seedGenerationJob(h.prisma, {
      subscriberId: sub.userId,
      modelId,
      status: 'FAILED',
      createdAt: new Date(Date.now() - 10 * STALE_AGO),
    });
    const res = await runSweep(h, CRON_SECRET);
    expect(res.json()).toMatchObject({ generationsReconciled: 0, generationsSkipped: 0 });
    expect(balanceOf(h, sub.userId)).toBe(100);
  });

  it('a replay refunds nothing a second time', async () => {
    seedPendingJob(h, sub.userId, modelId, STALE_AGO, 25);

    await runSweep(h, CRON_SECRET);
    const second = await runSweep(h, CRON_SECRET);

    expect(second.json()).toEqual({
      generationsReconciled: 0,
      generationsSkipped: 0,
      stalePayoutsFlagged: 0,
    });
    expect(balanceOf(h, sub.userId)).toBe(125);
    expect(audits(h, 'generation.reconciled_stale')).toHaveLength(1);
    expect(audits(h, 'reconciliation.run_completed')).toHaveLength(2);
  });

  it('two concurrent runs refund exactly once', async () => {
    seedPendingJob(h, sub.userId, modelId, STALE_AGO, 25);

    // Driven through the service directly so the interleaving is fixed: each
    // run issues its page read before its first await resolves, so both runs
    // hold the same stale row before either claims it. The compare-and-set on
    // PENDING then decides which one refunds.
    const service = createReconciliationService({
      prisma: h.prisma as unknown as PrismaClient,
      wallet: createWalletService({ prisma: h.prisma as unknown as PrismaClient }),
      generationStaleAfterMs: env.GENERATION_STALE_AFTER_MS,
      payoutStaleAfterHours: env.PAYOUT_STALE_AFTER_HOURS,
    });
    h.prisma.__resetCalls();
    const [a, b] = await Promise.all([service.run(), service.run()]);
    expect(h.prisma.__calls['generationJob.findMany']).toBe(2);

    const reconciled = a.generationsReconciled + b.generationsReconciled;
    const skipped = a.generationsSkipped + b.generationsSkipped;
    expect(reconciled).toBe(1);
    expect(skipped).toBe(1);
    expect(balanceOf(h, sub.userId)).toBe(125);
    expect(audits(h, 'generation.reconciled_stale')).toHaveLength(1);
    expect(audits(h, 'wallet.credited')).toHaveLength(1);
  });

  it('walks more than one page by keyset', async () => {
    const total = RECONCILIATION_BATCH_SIZE + 5;
    for (let i = 0; i < total; i++) {
      // Distinct subscribers: the one-pending-per-subscriber rule applies.
      seedPendingJob(h, `sub_bulk_${i}`, modelId, STALE_AGO, 10);
    }
    h.prisma.__resetCalls();

    const res = await runSweep(h, CRON_SECRET);
    expect(res.json().generationsReconciled).toBe(total);
    expect(h.prisma.__calls['generationJob.findMany']).toBe(2);
  });
});

// =============================================================================
describe('POST /api/admin/reconciliation/run — pass 2, stale payouts', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeApp();
    seedModel(h.prisma, 'm_1', 'm1@example.com');
  });

  it('flags a stale payout once per day and never changes its status', async () => {
    const stale = seedPayout(h, {
      modelId: 'm_1',
      status: 'PROCESSING',
      createdAt: new Date(Date.now() - (env.PAYOUT_STALE_AFTER_HOURS + 1) * HOUR_MS),
    });
    const stalePending = seedPayout(h, {
      modelId: 'm_1',
      status: 'PENDING',
      createdAt: new Date(Date.now() - (env.PAYOUT_STALE_AFTER_HOURS + 5) * HOUR_MS),
    });
    seedPayout(h, { modelId: 'm_1', status: 'PROCESSING', createdAt: new Date() }); // fresh
    seedPayout(h, {
      modelId: 'm_1',
      status: 'COMPLETED',
      createdAt: new Date(Date.now() - 30 * 24 * HOUR_MS),
    }); // settled

    const first = await runSweep(h, CRON_SECRET);
    expect(first.json()).toEqual({
      generationsReconciled: 0,
      generationsSkipped: 0,
      stalePayoutsFlagged: 2,
    });

    // Same UTC day → no second flag.
    const second = await runSweep(h, CRON_SECRET);
    expect(second.json().stalePayoutsFlagged).toBe(0);

    const flags = audits(h, 'payout.stale_detected');
    expect(flags.map((f) => f.entityId).sort()).toEqual([stale.id, stalePending.id].sort());
    expect(h.prisma.__payouts.find((p) => p.id === stale.id)!.status).toBe('PROCESSING');
    expect(h.prisma.__payouts.find((p) => p.id === stalePending.id)!.status).toBe('PENDING');
    expect(flags[0].metadata).not.toHaveProperty('recipientEmail');
  });

  it('flags again on the next UTC day', async () => {
    const payout = seedPayout(h, {
      modelId: 'm_1',
      createdAt: new Date(Date.now() - 200 * HOUR_MS),
    });
    const service = createReconciliationService({
      prisma: h.prisma as unknown as PrismaClient,
      wallet: createWalletService({ prisma: h.prisma as unknown as PrismaClient }),
      generationStaleAfterMs: env.GENERATION_STALE_AFTER_MS,
      payoutStaleAfterHours: 72,
    });
    const today = new Date('2026-09-27T08:00:00Z');
    const laterToday = new Date('2026-09-27T23:59:00Z');
    const tomorrow = new Date('2026-09-28T00:01:00Z');

    expect((await service.run(today)).stalePayoutsFlagged).toBe(1);
    expect((await service.run(laterToday)).stalePayoutsFlagged).toBe(0);
    expect((await service.run(tomorrow)).stalePayoutsFlagged).toBe(1);
    expect(audits(h, 'payout.stale_detected').map((f) => f.id)).toEqual([
      staleFlagId(payout.id, today),
      staleFlagId(payout.id, tomorrow),
    ]);
  });

  it('surfaces the stale count on the admin metrics overview', async () => {
    seedPayout(h, { modelId: 'm_1', createdAt: new Date(Date.now() - 100 * HOUR_MS) });
    seedPayout(h, { modelId: 'm_1', createdAt: new Date() });
    const admin = h.prisma.__users.find((u) => u.id === 'm_1')!;
    admin.role = 'ADMIN';
    const token = h.app.jwt.access.sign({ userId: 'm_1', role: 'admin' });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/admin/metrics/overview',
      cookies: { access_token: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().payouts.stalePayouts).toBe(1);
  });
});

// =============================================================================
describe('POST /api/admin/reconciliation/run — authentication', () => {
  it('rejects a missing, wrong, and near-miss secret with 401 and zero database calls', async () => {
    const h = await makeApp();
    seedPendingJob(h, 'sub_x', 'model_x', STALE_AGO);
    const calls = countEveryCall(h.prisma);

    const responses = [
      await runSweep(h),
      await runSweep(h, 'not-the-secret'),
      await runSweep(h, `${CRON_SECRET}x`),
      await runSweep(h, CRON_SECRET.slice(0, -1)),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    }
    expect(calls()).toBe(0);
    expect(h.prisma.__generationJobs[0].status).toBe('PENDING');
    expect(h.prisma.__auditLogs).toHaveLength(0);
  });
});
