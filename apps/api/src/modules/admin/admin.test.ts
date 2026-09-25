// =============================================================================
// Admin console integration tests (Session 11).
//
// Same posture as every prior suite: no real database, storage, provider or
// network. The in-memory Prisma fake, a fake storage client, a fake image
// processor, the mock payout adapter and the mock payment adapter are injected
// into buildServer(), and every request goes through Fastify's `inject` — so
// the RBAC hooks, the Zod schemas and the audit rows are all exercised through
// the real HTTP surface, not by calling service functions directly (except the
// one unit test that pins the unpublish seam).
//
// What is under test, per deliverable:
//   D1  a PENDING model cannot upload or take a subscription until approved,
//       and can the moment `POST /approve` lands; decisions are audited once
//   D2  suspension blocks login and refresh (403 account_suspended), reinstate
//       lifts it, an ADMIN can never be suspended, hashes never leave
//   D3  the overview is a fixed number of aggregate queries, per currency
//   D4  the admin run and the cron run are one function; non-admins touch
//       nothing
//   D5  one PENDING report per (content, reporter); resolution goes through
//       the existing publish toggle and the D2 suspend path
//   *   every /api/admin/* route is admin-only
// =============================================================================
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import {
  createFakeEmailer,
  createFakePrisma,
  seedContent,
  seedEarning,
  seedGenerationJob,
  seedModel,
  seedProfile,
  seedReferenceImage,
  seedSubscription,
  seedWallet,
  type FakePrisma,
} from '../../test/fake-prisma.js';
import { MockPayoutProvider } from '../payouts/adapters/mock.adapter.js';
import { MockPaymentProvider } from '../payments/adapters/mock.adapter.js';
import { createAdminService } from './admin.service.js';

const CRON_SECRET = 'test-payout-cron-secret';

// ── Fakes ────────────────────────────────────────────────────────────────────
function createFakeStorage(): StorageClient {
  return {
    uploadFile: vi.fn(async (_bucket: string, key: string) => key),
    getSignedUrl: vi.fn(
      async (_bucket: string, key: string, ttl: number) =>
        `https://signed.example/${key}?ttl=${ttl}`,
    ),
    getObject: vi.fn(async () => Buffer.from('RAW')),
    deleteFile: vi.fn(async () => {}),
  };
}

function createFakeImages(): ImageProcessor {
  return {
    getDimensions: vi.fn(async () => ({ width: 800, height: 600 })),
    watermark: vi.fn(async (buffer: Buffer) => buffer),
  };
}

async function makeApp(prisma: FakePrisma, payoutProvider = new MockPayoutProvider()) {
  const pix = new MockPaymentProvider({ channel: 'pix' });
  return buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage: createFakeStorage(),
    images: createFakeImages(),
    getPayoutProvider: () => payoutProvider,
    // The subscription-checkout gate under test fires before any provider
    // call, and the post-approval success path needs a provider that answers
    // without HTTP.
    getPaymentProvider: () => pix,
  });
}

type App = Awaited<ReturnType<typeof makeApp>>;

/** register → verify → login, returning the cookie jar the caller needs. */
async function loginAs(
  app: App,
  prisma: FakePrisma,
  role: 'model' | 'subscriber',
  email: string,
): Promise<{ access: string; refresh: string; userId: string }> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'supersecret', displayName: `Test ${role}`, role },
  });
  const user = prisma.__users.find((u) => u.email === email)!;
  await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${user.verifyToken}` });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'supersecret' },
  });
  return {
    access: login.cookies.find((c) => c.name === 'access_token')!.value,
    refresh: login.cookies.find((c) => c.name === 'refresh_token')!.value,
    userId: user.id,
  };
}

/** Promote a registered user to ADMIN and re-login (registration can't). */
async function loginAsAdmin(
  app: App,
  prisma: FakePrisma,
  email = 'admin@example.com',
): Promise<{ access: string; userId: string }> {
  const { userId } = await loginAs(app, prisma, 'subscriber', email);
  prisma.__users.find((u) => u.id === userId)!.role = 'ADMIN';
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'supersecret' },
  });
  return { access: login.cookies.find((c) => c.name === 'access_token')!.value, userId };
}

const audits = (prisma: FakePrisma, action: string) =>
  prisma.__auditLogs.filter((l) => l.action === action);

// Minimal valid PNG magic bytes for the upload gate test.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function multipartUpload(fields: Record<string, string>, file: Buffer) {
  const boundary = `----cpb${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    ),
  );
  chunks.push(file, Buffer.from('\r\n'), Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// ── §0 RBAC boundary ─────────────────────────────────────────────────────────
describe('/api/admin/* is admin-only', () => {
  const routes: Array<{
    method: 'GET' | 'POST';
    url: string;
    payload?: Record<string, unknown>;
  }> = [
    { method: 'GET', url: '/api/admin/models' },
    { method: 'POST', url: '/api/admin/models/u_x/approve' },
    { method: 'POST', url: '/api/admin/models/u_x/reject', payload: { reason: 'x' } },
    { method: 'GET', url: '/api/admin/users' },
    { method: 'GET', url: '/api/admin/users/u_x' },
    { method: 'POST', url: '/api/admin/users/u_x/suspend', payload: {} },
    { method: 'POST', url: '/api/admin/users/u_x/reinstate' },
    { method: 'GET', url: '/api/admin/metrics/overview' },
    { method: 'POST', url: '/api/admin/payouts/run' },
    { method: 'GET', url: '/api/admin/reports' },
    { method: 'POST', url: '/api/admin/reports/r_x/resolve', payload: { action: 'none' } },
  ];

  it('401s an anonymous caller and 403s a model and a subscriber on every route', async () => {
    const prisma = createFakePrisma();
    const app = await makeApp(prisma);
    const model = await loginAs(app, prisma, 'model', 'model@example.com');
    const subscriber = await loginAs(app, prisma, 'subscriber', 'sub@example.com');

    for (const route of routes) {
      const anon = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
      });
      expect(anon.statusCode, `anon ${route.method} ${route.url}`).toBe(401);
      for (const [who, cookie] of [
        ['model', model.access],
        ['subscriber', subscriber.access],
      ] as const) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          payload: route.payload,
          cookies: { access_token: cookie },
        });
        expect(res.statusCode, `${who} ${route.method} ${route.url}`).toBe(403);
      }
    }
    // Nothing above reached the service: no audit row, no state.
    expect(prisma.__auditLogs).toHaveLength(0);
  });
});

// ── §1 D1 — model approval ───────────────────────────────────────────────────
describe('D1 — model approval', () => {
  let prisma: FakePrisma;
  let app: App;
  let admin: { access: string; userId: string };
  let model: { access: string; refresh: string; userId: string };

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    admin = await loginAsAdmin(app, prisma);
    model = await loginAs(app, prisma, 'model', 'model@example.com');
    seedProfile(prisma, model.userId, undefined, { approvalStatus: 'PENDING', bio: 'hi' });
    seedReferenceImage(prisma, `mp_${model.userId}`);
    seedReferenceImage(prisma, `mp_${model.userId}`);
  });

  const asAdmin = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, cookies: { access_token: admin.access } });

  it('lists the pending queue with 300 s signed reference-image URLs and no storage key', async () => {
    seedModel(prisma, 'm_approved', 'approved@example.com');
    seedProfile(prisma, 'm_approved', undefined, { approvalStatus: 'APPROVED' });

    const res = await asAdmin('GET', '/api/admin/models');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 1, limit: 25, offset: 0 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      userId: model.userId,
      email: 'model@example.com',
      profile: { approvalStatus: 'PENDING', bio: 'hi' },
    });
    expect(body.items[0].referenceImages).toHaveLength(2);
    for (const img of body.items[0].referenceImages) {
      expect(img.signedUrl).toMatch(/^https:\/\/signed\.example\/reference-images\/.*ttl=300$/);
    }
    expect(JSON.stringify(body)).not.toContain('storageKey');

    const all = await asAdmin('GET', '/api/admin/models?status=all');
    expect(all.json().total).toBe(2);
    const approved = await asAdmin('GET', '/api/admin/models?status=approved');
    expect(approved.json().items.map((i: { userId: string }) => i.userId)).toEqual(['m_approved']);

    const bad = await asAdmin('GET', '/api/admin/models?status=bogus');
    expect(bad.statusCode).toBe(400);
  });

  it('approves once, audits once, and is a no-op the second time', async () => {
    const first = await asAdmin('POST', `/api/admin/models/${model.userId}/approve`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      userId: model.userId,
      approvalStatus: 'APPROVED',
      changed: true,
    });
    expect(first.json().approvalReviewedAt).toBeTruthy();

    const profile = prisma.__profiles.find((p) => p.userId === model.userId)!;
    expect(profile.approvalStatus).toBe('APPROVED');
    expect(profile.approvalReviewedAt).toBeInstanceOf(Date);

    const second = await asAdmin('POST', `/api/admin/models/${model.userId}/approve`);
    expect(second.statusCode).toBe(200);
    expect(second.json().changed).toBe(false);

    const rows = audits(prisma, 'model.approved');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.userId,
      entity: 'ModelProfile',
      entityId: profile.id,
      metadata: { modelId: model.userId, previousStatus: 'PENDING' },
    });
  });

  it('rejects with a required reason, records it, and approve still works afterwards', async () => {
    const missing = await asAdmin('POST', `/api/admin/models/${model.userId}/reject`, {});
    expect(missing.statusCode).toBe(400);
    const blank = await asAdmin('POST', `/api/admin/models/${model.userId}/reject`, {
      reason: '   ',
    });
    expect(blank.statusCode).toBe(400);
    expect(audits(prisma, 'model.rejected')).toHaveLength(0);

    const rejected = await asAdmin('POST', `/api/admin/models/${model.userId}/reject`, {
      reason: 'Reference images do not show a face',
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      approvalStatus: 'REJECTED',
      approvalRejectionReason: 'Reference images do not show a face',
      changed: true,
    });
    expect(audits(prisma, 'model.rejected')[0]).toMatchObject({
      actorId: admin.userId,
      metadata: { modelId: model.userId, reason: 'Reference images do not show a face' },
    });

    // Not a dead end: approve from REJECTED.
    const approved = await asAdmin('POST', `/api/admin/models/${model.userId}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      approvalStatus: 'APPROVED',
      approvalRejectionReason: null,
      changed: true,
    });
    expect(audits(prisma, 'model.approved')[0].metadata).toMatchObject({
      previousStatus: 'REJECTED',
      previousRejectionReason: 'Reference images do not show a face',
    });
  });

  it('404s an unknown id, a non-model id, and a model without a profile — never 500', async () => {
    const unknown = await asAdmin('POST', '/api/admin/models/nope/approve');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'model_not_found' });

    const subscriber = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    const notModel = await asAdmin('POST', `/api/admin/models/${subscriber.userId}/approve`);
    expect(notModel.statusCode).toBe(404);

    seedModel(prisma, 'm_noprofile', 'noprofile@example.com');
    const noProfile = await asAdmin('POST', '/api/admin/models/m_noprofile/reject', {
      reason: 'x',
    });
    expect(noProfile.statusCode).toBe(404);
    expect(noProfile.json()).toEqual({ error: 'model_profile_not_found' });
    expect(prisma.__auditLogs).toHaveLength(0);
  });

  it('gates content upload on approval: model_not_approved before, 201 after, same request', async () => {
    const upload = () => {
      const body = multipartUpload({ title: 'First', type: 'IMAGE', tier: 'STANDARD' }, PNG);
      return app.inject({
        method: 'POST',
        url: '/api/content/upload',
        cookies: { access_token: model.access },
        ...body,
      });
    };

    const before = await upload();
    expect(before.statusCode).toBe(403);
    expect(before.json()).toEqual({ error: 'model_not_approved' });
    expect(prisma.__content).toHaveLength(0);

    await asAdmin('POST', `/api/admin/models/${model.userId}/approve`);

    const after = await upload();
    expect(after.statusCode).toBe(201);
    expect(prisma.__content).toHaveLength(1);
  });

  it('gates subscription checkout on the model being approved, on top of the existing checks', async () => {
    const subscriber = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    const checkout = () =>
      app.inject({
        method: 'POST',
        url: '/api/payments/checkout/subscription',
        cookies: { access_token: subscriber.access },
        payload: { modelId: model.userId, tier: 'STANDARD', provider: 'pix' },
      });

    const before = await checkout();
    expect(before.statusCode).toBe(403);
    expect(before.json()).toEqual({ error: 'model_not_approved' });
    expect(prisma.__transactions).toHaveLength(0);

    await asAdmin('POST', `/api/admin/models/${model.userId}/approve`);

    const after = await checkout();
    expect(after.statusCode).toBe(201);
    expect(prisma.__transactions).toHaveLength(1);
  });
});

// ── §2 D2 — user management ──────────────────────────────────────────────────
describe('D2 — user management', () => {
  let prisma: FakePrisma;
  let app: App;
  let admin: { access: string; userId: string };

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    admin = await loginAsAdmin(app, prisma);
  });

  const asAdmin = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, cookies: { access_token: admin.access } });

  it('lists users with role and case-insensitive email filters, paginated, never a hash', async () => {
    await loginAs(app, prisma, 'model', 'alice.model@example.com');
    await loginAs(app, prisma, 'subscriber', 'bob@example.com');
    await loginAs(app, prisma, 'subscriber', 'carol@other.io');

    const all = await asAdmin('GET', '/api/admin/users');
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(4);
    for (const item of all.json().items) {
      expect(Object.keys(item).sort()).toEqual(
        ['createdAt', 'displayName', 'email', 'id', 'isVerified', 'role', 'suspendedAt'].sort(),
      );
    }
    expect(JSON.stringify(all.json())).not.toMatch(/hash/i);

    const models = await asAdmin('GET', '/api/admin/users?role=model');
    expect(models.json().items.map((u: { email: string }) => u.email)).toEqual([
      'alice.model@example.com',
    ]);

    const search = await asAdmin('GET', '/api/admin/users?email=EXAMPLE.com');
    expect(search.json().total).toBe(3);

    const page = await asAdmin('GET', '/api/admin/users?limit=2&offset=2');
    expect(page.json().items).toHaveLength(2);
    expect(page.json()).toMatchObject({ total: 4, limit: 2, offset: 2 });

    const tooBig = await asAdmin('GET', '/api/admin/users?limit=101');
    expect(tooBig.statusCode).toBe(400);
  });

  it('returns role-specific rollups on the detail read', async () => {
    const model = await loginAs(app, prisma, 'model', 'model@example.com');
    seedProfile(prisma, model.userId, 'model@paxum.example', { approvalStatus: 'PENDING' });
    const subscriber = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    seedSubscription(prisma, { subscriberId: subscriber.userId, modelId: model.userId });
    seedSubscription(prisma, {
      subscriberId: subscriber.userId,
      modelId: 'm_other',
      status: 'EXPIRED',
    });
    seedWallet(prisma, subscriber.userId, 120);

    const m = await asAdmin('GET', `/api/admin/users/${model.userId}`);
    expect(m.statusCode).toBe(200);
    expect(m.json()).toMatchObject({
      role: 'model',
      model: { approvalStatus: 'PENDING', payoutEmailConfigured: true },
      subscriber: null,
    });

    const s = await asAdmin('GET', `/api/admin/users/${subscriber.userId}`);
    expect(s.json()).toMatchObject({
      role: 'subscriber',
      model: null,
      subscriber: { activeSubscriptions: 1, walletBalance: 120 },
    });

    const missing = await asAdmin('GET', '/api/admin/users/nope');
    expect(missing.statusCode).toBe(404);
  });

  it('suspends: login and refresh answer 403 account_suspended; reinstate lifts it', async () => {
    const user = await loginAs(app, prisma, 'subscriber', 'sub@example.com');

    const suspended = await asAdmin('POST', `/api/admin/users/${user.userId}/suspend`, {
      reason: 'chargeback abuse',
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({ userId: user.userId, changed: true });
    expect(suspended.json().suspendedAt).toBeTruthy();
    expect(audits(prisma, 'user.suspended')).toHaveLength(1);
    expect(audits(prisma, 'user.suspended')[0]).toMatchObject({
      actorId: admin.userId,
      entityId: user.userId,
      metadata: { targetUserId: user.userId, targetRole: 'subscriber', reason: 'chargeback abuse' },
    });

    // The existing session cannot refresh …
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refresh_token: user.refresh },
    });
    expect(refresh.statusCode).toBe(403);
    expect(refresh.json()).toEqual({ error: 'account_suspended' });

    // … and a fresh login is refused with the same code.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'sub@example.com', password: 'supersecret' },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toEqual({ error: 'account_suspended' });

    // Idempotent: a second suspend changes nothing and writes no second row.
    const again = await asAdmin('POST', `/api/admin/users/${user.userId}/suspend`, {});
    expect(again.json().changed).toBe(false);
    expect(audits(prisma, 'user.suspended')).toHaveLength(1);

    const reinstated = await asAdmin('POST', `/api/admin/users/${user.userId}/reinstate`);
    expect(reinstated.statusCode).toBe(200);
    expect(reinstated.json()).toEqual({ userId: user.userId, suspendedAt: null, changed: true });
    expect(audits(prisma, 'user.reinstated')).toHaveLength(1);

    const loginAgain = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'sub@example.com', password: 'supersecret' },
    });
    expect(loginAgain.statusCode).toBe(200);

    const reinstateAgain = await asAdmin('POST', `/api/admin/users/${user.userId}/reinstate`);
    expect(reinstateAgain.json().changed).toBe(false);
    expect(audits(prisma, 'user.reinstated')).toHaveLength(1);
  });

  it('never suspends an ADMIN — 403, no state change, no audit row', async () => {
    const other = await loginAsAdmin(app, prisma, 'other-admin@example.com');

    const res = await asAdmin('POST', `/api/admin/users/${other.userId}/suspend`, {
      reason: 'x',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'cannot_suspend_admin' });
    expect(prisma.__users.find((u) => u.id === other.userId)!.suspendedAt).toBeNull();
    expect(audits(prisma, 'user.suspended')).toHaveLength(0);

    // Including yourself.
    const self = await asAdmin('POST', `/api/admin/users/${admin.userId}/suspend`, {});
    expect(self.statusCode).toBe(403);

    const missing = await asAdmin('POST', '/api/admin/users/nope/suspend', {});
    expect(missing.statusCode).toBe(404);
  });
});

// ── §3 D3 — metrics overview ─────────────────────────────────────────────────
describe('D3 — GET /api/admin/metrics/overview', () => {
  let prisma: FakePrisma;
  let app: App;
  let admin: { access: string; userId: string };
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    admin = await loginAsAdmin(app, prisma);
  });

  const overview = () =>
    app.inject({
      method: 'GET',
      url: '/api/admin/metrics/overview',
      cookies: { access_token: admin.access },
    });

  it('reports every figure per currency and never sums across them', async () => {
    // Subscriptions: two STANDARD on PIX (BRL), one PREMIUM on crypto (USD),
    // one on the offline mock (currency unknowable), one expired.
    seedSubscription(prisma, { subscriberId: 's1', modelId: 'm1', tier: 'STANDARD' });
    seedSubscription(prisma, { subscriberId: 's1', modelId: 'm2', tier: 'STANDARD' });
    seedSubscription(prisma, {
      subscriberId: 's2',
      modelId: 'm1',
      tier: 'PREMIUM',
      provider: 'NOWPAYMENTS',
    });
    seedSubscription(prisma, {
      subscriberId: 's3',
      modelId: 'm1',
      tier: 'STANDARD',
      provider: 'CCBILL_MOCK',
    });
    seedSubscription(prisma, { subscriberId: 's4', modelId: 'm1', status: 'EXPIRED' });

    // Credit packs: BRL + USD inside the window, one outside, one unconfirmed.
    const now = Date.now();
    seedEarning(prisma, {
      modelId: null as unknown as string,
      modelShareCents: 0,
      type: 'CREDIT_PACK',
      amount: 1990,
      currency: 'BRL',
      confirmedAt: new Date(now - 2 * DAY),
    });
    seedEarning(prisma, {
      modelId: null as unknown as string,
      modelShareCents: 0,
      type: 'CREDIT_PACK',
      amount: 3990,
      currency: 'BRL',
      confirmedAt: new Date(now - 10 * DAY),
    });
    seedEarning(prisma, {
      modelId: null as unknown as string,
      modelShareCents: 0,
      type: 'CREDIT_PACK',
      amount: 499,
      currency: 'USD',
      confirmedAt: new Date(now - 1 * DAY),
    });
    seedEarning(prisma, {
      modelId: null as unknown as string,
      modelShareCents: 0,
      type: 'CREDIT_PACK',
      amount: 99999,
      currency: 'BRL',
      confirmedAt: new Date(now - 45 * DAY),
    });
    seedEarning(prisma, {
      modelId: null as unknown as string,
      modelShareCents: 0,
      type: 'CREDIT_PACK',
      amount: 77777,
      currency: 'BRL',
      status: 'PENDING',
      confirmedAt: null,
    });

    // Generations in the window: 2 completed, 1 failed, 1 pending; one old.
    for (const status of ['COMPLETED', 'COMPLETED', 'FAILED', 'PENDING'] as const) {
      seedGenerationJob(prisma, { subscriberId: 's1', modelId: 'm1', status });
    }
    seedGenerationJob(prisma, {
      subscriberId: 's1',
      modelId: 'm1',
      status: 'COMPLETED',
      createdAt: new Date(now - 60 * DAY),
    });

    // Payouts: totals by status and currency; FAILED excluded.
    for (const [status, amountCents, currency] of [
      ['PENDING', 6000, 'BRL'],
      ['COMPLETED', 9000, 'BRL'],
      ['COMPLETED', 1200, 'USD'],
      ['FAILED', 5000, 'BRL'],
    ] as const) {
      prisma.__payouts.push({
        id: `po_${status}_${amountCents}`,
        modelId: 'm1',
        amountCents,
        currency,
        status,
        provider: 'PAXUM_MOCK',
        providerPayoutId: null,
        idempotencyKey: `k_${status}_${amountCents}`,
        periodStart: new Date(now - 7 * DAY),
        periodEnd: new Date(now),
        failureReason: null,
        createdAt: new Date(now),
        completedAt: null,
      });
    }

    // Payable balances: m_with (above, has email), m_without (above, none),
    // m_low (below threshold, none — not counted).
    seedModel(prisma, 'm_with', 'with@example.com');
    seedProfile(prisma, 'm_with', 'with@paxum.example');
    seedEarning(prisma, { modelId: 'm_with', modelShareCents: 8000 });
    seedModel(prisma, 'm_without', 'without@example.com');
    seedProfile(prisma, 'm_without');
    seedEarning(prisma, { modelId: 'm_without', modelShareCents: 5000 });
    seedModel(prisma, 'm_low', 'low@example.com');
    seedEarning(prisma, { modelId: 'm_low', modelShareCents: 4999 });

    const res = await overview();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.windowDays).toBe(30);
    expect(body.subscribers).toEqual({ active: 3 });
    expect(body.subscriptions).toEqual({
      active: { total: 4, byTier: { STANDARD: 3, PREMIUM: 1 } },
    });
    expect(body.recurringRevenue).toEqual({
      byCurrency: [
        { currency: 'BRL', subscriptions: 2, amountCents: 2 * 2990 },
        { currency: 'USD', subscriptions: 1, amountCents: 1199 },
      ],
      unattributedSubscriptions: 1,
    });
    expect(body.creditPackRevenue).toEqual({
      byCurrency: [
        { currency: 'BRL', amountCents: 1990 + 3990 },
        { currency: 'USD', amountCents: 499 },
      ],
    });
    expect(body.generations).toEqual({
      total: 4,
      completed: 2,
      failed: 1,
      pending: 1,
      completionRate: 2 / 3,
    });
    expect(body.payouts).toEqual({
      byStatus: [
        { status: 'PENDING', currency: 'BRL', count: 1, amountCents: 6000 },
        { status: 'COMPLETED', currency: 'BRL', count: 1, amountCents: 9000 },
        { status: 'COMPLETED', currency: 'USD', count: 1, amountCents: 1200 },
      ],
      modelsAboveThresholdWithoutPayoutEmail: 1,
      thresholdCents: 5000,
    });
    // No figure anywhere is a cross-currency total.
    expect(JSON.stringify(body)).not.toContain('"totalCents"');
  });

  it('issues a fixed number of aggregate queries however many rows exist', async () => {
    for (let i = 0; i < 60; i++) {
      seedModel(prisma, `m_${i}`, `m${i}@example.com`);
      seedProfile(prisma, `m_${i}`, i % 2 === 0 ? `m${i}@paxum.example` : undefined);
      seedSubscription(prisma, { subscriberId: `s_${i}`, modelId: `m_${i}` });
      seedSubscription(prisma, { subscriberId: `s_${i}`, modelId: `m_${(i + 1) % 60}` });
      seedEarning(prisma, { modelId: `m_${i}`, modelShareCents: 6000 });
      seedEarning(prisma, {
        modelId: null as unknown as string,
        modelShareCents: 0,
        type: 'CREDIT_PACK',
        amount: 1000,
        confirmedAt: new Date(),
      });
      seedGenerationJob(prisma, { subscriberId: `s_${i}`, modelId: `m_${i}` });
    }

    prisma.__resetCalls();
    const res = await overview();
    expect(res.statusCode).toBe(200);
    expect(res.json().subscribers.active).toBe(60);
    expect(res.json().payouts.modelsAboveThresholdWithoutPayoutEmail).toBe(30);

    // Two subscription groupBys, two transaction groupBys, one each on
    // generations and payouts, one profile count — and nothing per row.
    expect(prisma.__calls).toEqual({
      'subscription.groupBy': 2,
      'paymentTransaction.groupBy': 2,
      'generationJob.groupBy': 1,
      'payout.groupBy': 1,
      'modelProfile.count': 1,
    });
  });
});

// ── §4 D4 — on-demand payout run ─────────────────────────────────────────────
describe('D4 — POST /api/admin/payouts/run', () => {
  /** The same ledger, seeded twice, so the two entrances can be compared. */
  function seedLedger(prisma: FakePrisma) {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 4000 });
    seedModel(prisma, 'm_poor', 'poor@example.com');
    seedProfile(prisma, 'm_poor', 'poor@paxum.example');
    seedEarning(prisma, { modelId: 'm_poor', modelShareCents: 4999 });
    seedModel(prisma, 'm_noemail', 'noemail@example.com');
    seedProfile(prisma, 'm_noemail');
    seedEarning(prisma, { modelId: 'm_noemail', modelShareCents: 7000 });
  }

  /** Everything a run leaves behind, minus ids and timestamps. */
  function footprint(prisma: FakePrisma) {
    return {
      payouts: prisma.__payouts
        .map((p) => ({
          modelId: p.modelId,
          amountCents: p.amountCents,
          currency: p.currency,
          status: p.status,
          provider: p.provider,
        }))
        .sort((a, b) => a.modelId.localeCompare(b.modelId)),
      claimed: prisma.__transactions
        .map((t) => ({ modelId: t.modelId, claimed: t.payoutId !== null }))
        .sort((a, b) => String(a.modelId).localeCompare(String(b.modelId))),
      audit: prisma.__auditLogs
        .map((l) => l.action)
        .filter((a) => a.startsWith('payout.'))
        .sort(),
    };
  }

  it('drives the same function as the cron route — identical side effects, different trigger on the audit row', async () => {
    const viaCron = createFakePrisma();
    const cronApp = await makeApp(viaCron);
    seedLedger(viaCron);
    const cronRes = await cronApp.inject({
      method: 'POST',
      url: '/api/payouts/run',
      headers: { 'x-payout-cron-secret': CRON_SECRET },
    });

    const viaAdmin = createFakePrisma();
    const adminApp = await makeApp(viaAdmin);
    const admin = await loginAsAdmin(adminApp, viaAdmin);
    seedLedger(viaAdmin);
    const adminRes = await adminApp.inject({
      method: 'POST',
      url: '/api/admin/payouts/run',
      cookies: { access_token: admin.access },
    });

    expect(cronRes.statusCode).toBe(200);
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.json()).toEqual(cronRes.json());
    expect(adminRes.json()).toEqual({ processed: 1, skipped: 2, failed: 0, totalCents: 12000 });
    expect(footprint(viaAdmin)).toEqual(footprint(viaCron));

    const cronRun = audits(viaCron, 'payout.run_completed')[0];
    const adminRun = audits(viaAdmin, 'payout.run_completed')[0];
    expect(cronRun).toMatchObject({ actorId: null, metadata: { triggeredBy: 'cron' } });
    expect(adminRun).toMatchObject({ actorId: admin.userId, metadata: { triggeredBy: 'admin' } });
    // Apart from who triggered it, the summary rows are the same record.
    const strip = (m: unknown) => {
      const {
        triggeredBy: _t,
        periodStart: _s,
        periodEnd: _e,
        ...rest
      } = m as Record<string, unknown>;
      return rest;
    };
    expect(strip(adminRun.metadata)).toEqual(strip(cronRun.metadata));
  });

  it('403s a non-admin without touching a Payout or PaymentTransaction row', async () => {
    const prisma = createFakePrisma();
    const app = await makeApp(prisma);
    seedLedger(prisma);
    const model = await loginAs(app, prisma, 'model', 'model@example.com');
    const before = JSON.stringify(prisma.__transactions);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/payouts/run',
      cookies: { access_token: model.access },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.__payouts).toHaveLength(0);
    expect(JSON.stringify(prisma.__transactions)).toBe(before);
    expect(audits(prisma, 'payout.run_completed')).toHaveLength(0);
  });
});

// ── §5 D5 — content moderation ───────────────────────────────────────────────
describe('D5 — content moderation', () => {
  let prisma: FakePrisma;
  let app: App;
  let admin: { access: string; userId: string };
  let model: { access: string; refresh: string; userId: string };
  let subscriber: { access: string; userId: string };
  let contentId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    admin = await loginAsAdmin(app, prisma);
    model = await loginAs(app, prisma, 'model', 'model@example.com');
    seedProfile(prisma, model.userId);
    subscriber = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    contentId = seedContent(prisma, { modelId: model.userId, title: 'Reported item' }).id;
  });

  const report = (
    cookie: string,
    id = contentId,
    payload: Record<string, unknown> = { reason: 'SPAM' },
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/content/${id}/report`,
      cookies: { access_token: cookie },
      payload,
    });
  const asAdmin = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, cookies: { access_token: admin.access } });

  it('accepts one PENDING report per (content, reporter) — the repeat is a 200 no-op', async () => {
    const first = await report(subscriber.access, contentId, {
      reason: 'NON_CONSENSUAL',
      details: 'This is not the model',
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ contentId, status: 'PENDING' });
    const reportId = first.json().reportId;

    const repeat = await report(subscriber.access, contentId, { reason: 'SPAM' });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().reportId).toBe(reportId);
    expect(prisma.__reports).toHaveLength(1);
    expect(prisma.__reports[0].reason).toBe('NON_CONSENSUAL');

    // A different reporter (a model counts — anyone authenticated) is a new row.
    const other = await report(model.access);
    expect(other.statusCode).toBe(201);
    expect(prisma.__reports).toHaveLength(2);
  });

  it('validates the request and the target', async () => {
    expect((await report(subscriber.access, contentId, { reason: 'RUDE' })).statusCode).toBe(400);
    expect((await report(subscriber.access, 'nope')).statusCode).toBe(404);
    const deleted = seedContent(prisma, { modelId: model.userId, deletedAt: new Date() }).id;
    expect((await report(subscriber.access, deleted)).statusCode).toBe(404);
    const anon = await app.inject({
      method: 'POST',
      url: `/api/content/${contentId}/report`,
      payload: { reason: 'SPAM' },
    });
    expect(anon.statusCode).toBe(401);
    expect(prisma.__reports).toHaveLength(0);
  });

  it('rate-limits reports per caller (10/hour), not per IP', async () => {
    const items = Array.from(
      { length: 11 },
      () => seedContent(prisma, { modelId: model.userId }).id,
    );
    for (const id of items.slice(0, 10)) {
      expect((await report(subscriber.access, id)).statusCode).toBe(201);
    }
    // The 11th from the same account is refused …
    expect((await report(subscriber.access, items[10])).statusCode).toBe(429);
    // … while another account behind the same (inject) IP still has its own budget.
    const other = await loginAs(app, prisma, 'subscriber', 'other-sub@example.com');
    expect((await report(other.access, items[10])).statusCode).toBe(201);
    expect(prisma.__reports).toHaveLength(11);
  });

  it('lists the pending queue with the reported item and its owner joined', async () => {
    await report(subscriber.access, contentId, { reason: 'ILLEGAL', details: '<b>x</b>' });

    const res = await asAdmin('GET', '/api/admin/reports');
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0]).toMatchObject({
      reason: 'ILLEGAL',
      // Stored verbatim; escaping is the renderer's job, never the store's.
      details: '<b>x</b>',
      status: 'PENDING',
      reporter: { userId: subscriber.userId, email: 'sub@example.com' },
      content: {
        contentId,
        title: 'Reported item',
        isPublished: true,
        owner: { userId: model.userId, email: 'model@example.com', suspendedAt: null },
      },
    });
    expect(JSON.stringify(res.json())).not.toContain('storageKey');

    const resolved = await asAdmin('GET', '/api/admin/reports?status=resolved');
    expect(resolved.json().total).toBe(0);
  });

  it("resolves with 'none': the report closes, the content stays up, one audit row", async () => {
    const { reportId } = (await report(subscriber.access)).json();

    const res = await asAdmin('POST', `/api/admin/reports/${reportId}/resolve`, {
      action: 'none',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reportId,
      status: 'RESOLVED',
      resolvedAction: 'none',
      contentUnpublished: false,
      modelSuspended: false,
    });
    expect(prisma.__reports[0]).toMatchObject({ status: 'RESOLVED', resolvedAction: 'none' });
    expect(prisma.__reports[0].resolvedAt).toBeInstanceOf(Date);
    expect(prisma.__content[0].isPublished).toBe(true);
    expect(audits(prisma, 'report.resolved')).toHaveLength(1);
    expect(audits(prisma, 'report.resolved')[0]).toMatchObject({
      actorId: admin.userId,
      entityId: reportId,
      metadata: { reportId, contentId, action: 'none' },
    });

    // Twice is a conflict, not a second resolution.
    const again = await asAdmin('POST', `/api/admin/reports/${reportId}/resolve`, {
      action: 'unpublish',
    });
    expect(again.statusCode).toBe(409);
    expect(prisma.__content[0].isPublished).toBe(true);
    expect(audits(prisma, 'report.resolved')).toHaveLength(1);

    // And once resolved, the same reporter may report the item again.
    expect((await report(subscriber.access)).statusCode).toBe(201);
    expect(prisma.__reports).toHaveLength(2);
  });

  it("resolves with 'unpublish': Content.isPublished flips to false", async () => {
    const { reportId } = (await report(subscriber.access)).json();

    const res = await asAdmin('POST', `/api/admin/reports/${reportId}/resolve`, {
      action: 'unpublish',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ contentUnpublished: true, modelSuspended: false });
    expect(prisma.__content[0].isPublished).toBe(false);
    expect(prisma.__users.find((u) => u.id === model.userId)!.suspendedAt).toBeNull();
    expect(audits(prisma, 'user.suspended')).toHaveLength(0);
  });

  it("resolves with 'unpublish_and_suspend_model': the owner's next login is blocked", async () => {
    const { reportId } = (await report(subscriber.access)).json();

    const res = await asAdmin('POST', `/api/admin/reports/${reportId}/resolve`, {
      action: 'unpublish_and_suspend_model',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ contentUnpublished: true, modelSuspended: true });
    expect(prisma.__content[0].isPublished).toBe(false);
    expect(prisma.__users.find((u) => u.id === model.userId)!.suspendedAt).toBeInstanceOf(Date);

    // Through the D2 path: its audit row, with the report as the reason.
    expect(audits(prisma, 'user.suspended')).toHaveLength(1);
    expect(audits(prisma, 'user.suspended')[0]).toMatchObject({
      actorId: admin.userId,
      entityId: model.userId,
      metadata: { reason: expect.stringContaining(reportId) },
    });
    expect(audits(prisma, 'report.resolved')[0].metadata).toMatchObject({
      action: 'unpublish_and_suspend_model',
      modelSuspended: true,
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'model@example.com', password: 'supersecret' },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toEqual({ error: 'account_suspended' });
  });

  it('rejects an unknown report, an unknown action, and a bad id shape', async () => {
    expect(
      (await asAdmin('POST', '/api/admin/reports/nope/resolve', { action: 'none' })).statusCode,
    ).toBe(404);
    const { reportId } = (await report(subscriber.access)).json();
    expect(
      (await asAdmin('POST', `/api/admin/reports/${reportId}/resolve`, { action: 'ban' }))
        .statusCode,
    ).toBe(400);
    expect(prisma.__reports[0].status).toBe('PENDING');
  });

  it('opens PATCH /publish to admins for anyone’s content, while models stay owner-only', async () => {
    const other = await loginAs(app, prisma, 'model', 'other@example.com');
    const asOther = await app.inject({
      method: 'PATCH',
      url: `/api/content/${contentId}/publish`,
      cookies: { access_token: other.access },
      payload: { publish: false },
    });
    expect(asOther.statusCode).toBe(403);
    expect(prisma.__content[0].isPublished).toBe(true);

    const asAdminRes = await app.inject({
      method: 'PATCH',
      url: `/api/content/${contentId}/publish`,
      cookies: { access_token: admin.access },
      payload: { publish: false },
    });
    expect(asAdminRes.statusCode).toBe(200);
    expect(asAdminRes.json()).toEqual({ contentId, isPublished: false });
    expect(prisma.__content[0].isPublished).toBe(false);
  });

  it('unpublishes through the injected content-service toggle, not a second implementation', async () => {
    // Unit-level pin on the seam: the admin service is given `setPublish` and
    // must call it with the admin role for the reported content.
    const setPublish = vi.fn(async (_userId: string, id: string) => ({
      contentId: id,
      isPublished: false,
    }));
    const service = createAdminService({
      prisma: prisma as unknown as PrismaClient,
      storage: createFakeStorage(),
      bucket: 'test-bucket',
      setPublish,
      runPayouts: vi.fn(async () => ({ processed: 0, skipped: 0, failed: 0, totalCents: 0 })),
      payoutMinThresholdCents: 5000,
    });
    const { reportId } = (await report(subscriber.access)).json();

    await service.resolveReport(admin.userId, reportId, 'unpublish');

    expect(setPublish).toHaveBeenCalledTimes(1);
    expect(setPublish).toHaveBeenCalledWith(admin.userId, contentId, false, 'admin');
  });
});
