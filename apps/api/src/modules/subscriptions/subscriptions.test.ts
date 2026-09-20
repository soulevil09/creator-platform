// =============================================================================
// Subscription lifecycle tests (Session 06.5).
//
// Same posture as the Session 05/06 suites: **nock** for HTTP with
// `nock.disableNetConnect()` so an un-mocked provider call is a loud failure,
// the shared in-memory Prisma fake for everything else, and no real database,
// provider, or network anywhere.
//
// The properties under test:
//   * a renewal charge is issued once per period, not once per run
//   * every transition is conditional, so re-running a sweep is a no-op
//   * an opt-out lands on CANCELED and a non-payer on EXPIRED — never swapped
//   * cancelling keeps the access already paid for (nothing revoked)
//   * /renewals/run is closed without the exact cron secret, before any DB work
//   * paying the reminder charge reactivates the subscription through the
//     Session 05 webhook path, with no new code — the seam still holds
import { createHmac } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRenewalReminderEmail, type Emailer } from '../../lib/email.js';
import type { ImageProcessor } from '../../lib/image.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import { buildServer } from '../../index.js';
import {
  createFakePrisma,
  seedContent,
  seedProfile,
  seedSubscription,
  type FakePrisma,
} from '../../test/fake-prisma.js';

const WOOVI_URL = 'https://woovi.test';
const OPENPIX_SECRET = 'test-openpix-webhook-secret';
const CRON_SECRET = 'test-renewal-cron-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Fakes for the dependencies buildServer still needs ───────────────────────
function createFakeStorage(): StorageClient {
  return {
    uploadFile: vi.fn(async (_bucket: string, key: string) => key),
    getSignedUrl: vi.fn(async (_bucket: string, key: string) => `https://signed.example/${key}`),
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

/**
 * Records what the renewal sweep tried to send, so the tests can assert on it.
 * `rendered` (Session 10) additionally runs the real template layer for the
 * locale the sweep passed, so the localisation tests see the exact subject and
 * body a subscriber would — with no Resend client anywhere.
 */
function createRecordingEmailer() {
  const reminders: Array<{ to: string; amountCents: number; currency: string }> = [];
  const rendered: Array<{ to: string; locale: string; subject: string; html: string }> = [];
  const emailer: Emailer = {
    sendVerificationEmail: vi.fn(async () => {}),
    sendRenewalReminderEmail: vi.fn(async (to, params, locale) => {
      reminders.push({ to, amountCents: params.amountCents, currency: params.currency });
      rendered.push({ to, locale, ...renderRenewalReminderEmail(params, locale) });
    }),
  };
  return { emailer, reminders, rendered };
}

async function makeApp(prisma: FakePrisma, emailer: Emailer) {
  return buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer,
    storage: createFakeStorage(),
    images: createFakeImages(),
  });
}

type App = Awaited<ReturnType<typeof makeApp>>;

/** register → verify → login, returning the access_token cookie value. */
async function loginAs(
  app: App,
  prisma: FakePrisma,
  role: 'model' | 'subscriber',
  email: string,
): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'supersecret', displayName: `Test ${role}`, role },
  });
  const token = prisma.__users.find((u) => u.email === email)!.verifyToken!;
  await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}` });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'supersecret' },
  });
  return login.cookies.find((c) => c.name === 'access_token')!.value;
}

const userIdFor = (prisma: FakePrisma, email: string) =>
  prisma.__users.find((u) => u.email === email)!.id;

const wooviSignature = (rawBody: string) =>
  createHmac('sha256', OPENPIX_SECRET).update(rawBody).digest('base64');

const wooviChargeReply = (correlationId: string) => ({
  charge: {
    correlationID: correlationId,
    transactionID: 'woovi_tx_123',
    status: 'ACTIVE',
    brCode: '00020126580014BR.GOV.BCB.PIX0136copia-e-cola6304ABCD',
    qrCodeImage: 'https://api.woovi.com/openpix/charge/brcode/image/abc.png',
  },
});

/** One Woovi charge creation, which is what a renewal issues. */
function expectWooviCharge() {
  nock(WOOVI_URL)
    .post('/api/v1/subscriptions')
    .reply(200, { subscription: { globalID: 's1' } });
  nock(WOOVI_URL).post('/api/v1/charge').reply(200, wooviChargeReply('unused'));
}

const runSweep = (app: App, secret: string = CRON_SECRET) =>
  app.inject({
    method: 'POST',
    url: '/api/subscriptions/renewals/run',
    headers: { 'x-renewal-cron-secret': secret },
  });

beforeAll(() => {
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
  nock.restore();
});

afterEach(() => {
  nock.cleanAll();
});

// =============================================================================
describe('subscription lifecycle', () => {
  let prisma: FakePrisma;
  let app: App;
  let emailer: Emailer;
  let reminders: Array<{ to: string; amountCents: number; currency: string }>;
  let rendered: Array<{ to: string; locale: string; subject: string; html: string }>;
  let modelId: string;
  let subscriberId: string;
  let subCookie: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    ({ emailer, reminders, rendered } = createRecordingEmailer());
    app = await makeApp(prisma, emailer);

    await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
    seedProfile(prisma, modelId);
    seedContent(prisma, { modelId, tier: 'STANDARD' });

    subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    subscriberId = userIdFor(prisma, 'sub@example.com');
  });

  /**
   * A confirmed BRL payment for this pair — the row the sweep reads to decide
   * which rail to renew on.
   */
  function seedPaidHistory(currency = 'BRL', createdAt = new Date(Date.now() - 27 * DAY_MS)) {
    prisma.__transactions.push({
      id: `tx_hist_${prisma.__transactions.length + 1}`,
      userId: subscriberId,
      type: 'SUBSCRIPTION',
      provider: 'WOOVI',
      providerTransactionId: 'woovi_tx_hist',
      idempotencyKey: `sub_hist_${prisma.__transactions.length + 1}`,
      amount: 2990,
      currency,
      creditsGranted: null,
      modelId,
      tier: 'STANDARD',
      status: 'CONFIRMED',
      confirmedAt: createdAt,
      metadata: null,
      modelShareCents: 2392,
      platformShareCents: 598,
      payoutId: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  // ── §1 Renewal sweep: reminders ────────────────────────────────────────────
  describe('renewal reminders', () => {
    it('issues one charge for a subscription 2 days out, and nothing on a rerun', async () => {
      seedPaidHistory();
      const sub = seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() + 2 * DAY_MS),
      });

      expectWooviCharge();
      const first = await runSweep(app);
      expect(first.statusCode).toBe(200);
      expect(first.json().remindersIssued).toBe(1);
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toEqual({
        to: 'sub@example.com',
        amountCents: 2990,
        currency: 'BRL',
      });

      const pending = prisma.__transactions.filter(
        (t) => t.status === 'PENDING' && t.type === 'SUBSCRIPTION',
      );
      expect(pending).toHaveLength(1);

      // Second run the same day: the outstanding PENDING charge is what makes
      // this idempotent, so no nock interceptor is armed — a second provider
      // call would be a hard failure here, which is exactly the point.
      const second = await runSweep(app);
      expect(second.json().remindersIssued).toBe(0);
      expect(reminders).toHaveLength(1);
      expect(
        prisma.__transactions.filter((t) => t.status === 'PENDING' && t.type === 'SUBSCRIPTION'),
      ).toHaveLength(1);

      // Nothing about the subscription itself changed — it is still ACTIVE for
      // the two days the subscriber already paid for.
      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.status).toBe('ACTIVE');
    });

    // ── Session 10 (D3): the reminder goes out in the subscriber's language ──
    describe('locale-aware reminder email', () => {
      /** Set the language through the real write path, not by poking the row. */
      async function chooseLocale(locale: 'pt-BR' | 'en') {
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/auth/me/locale',
          cookies: { access_token: subCookie },
          payload: { locale },
        });
        expect(res.statusCode).toBe(200);
      }

      /** Intl separates symbol and number with U+00A0; normalise for asserts. */
      const nbsp = (s: string) => s.replace(/\u00a0/g, ' ');

      it('sends the Portuguese template with a comma-decimal amount for preferredLocale pt-BR', async () => {
        await chooseLocale('pt-BR');
        seedPaidHistory();
        seedSubscription(prisma, {
          subscriberId,
          modelId,
          currentPeriodEnd: new Date(Date.now() + 2 * DAY_MS),
        });

        expectWooviCharge();
        const res = await runSweep(app);
        expect(res.json().remindersIssued).toBe(1);

        expect(rendered).toHaveLength(1);
        expect(rendered[0].to).toBe('sub@example.com');
        expect(rendered[0].locale).toBe('pt-BR');
        expect(rendered[0].subject).toBe('Sua assinatura de Test model renova em breve');
        expect(nbsp(rendered[0].html)).toContain('pague R$ 29,90');
        expect(rendered[0].html).toContain('Pague com PIX');
        expect(rendered[0].html).not.toMatch(/renews soon|To keep access/);
      });

      it('sends the English template with a dot-decimal amount for preferredLocale en', async () => {
        await chooseLocale('en');
        seedPaidHistory();
        seedSubscription(prisma, {
          subscriberId,
          modelId,
          currentPeriodEnd: new Date(Date.now() + 2 * DAY_MS),
        });

        expectWooviCharge();
        const res = await runSweep(app);
        expect(res.json().remindersIssued).toBe(1);

        expect(rendered).toHaveLength(1);
        expect(rendered[0].locale).toBe('en');
        expect(rendered[0].subject).toBe('Your Test model subscription renews soon');
        expect(nbsp(rendered[0].html)).toContain('pay R$29.90');
        expect(rendered[0].html).toContain('Pay with PIX');
        expect(rendered[0].html).not.toMatch(/renova em breve|manter o acesso/);
      });
    });

    it('leaves a subscription well outside the reminder window alone', async () => {
      seedPaidHistory();
      seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
      });

      const res = await runSweep(app);
      expect(res.json().remindersIssued).toBe(0);
      expect(reminders).toHaveLength(0);
    });

    it('issues no renewal charge for a subscription that opted out', async () => {
      seedPaidHistory();
      seedSubscription(prisma, {
        subscriberId,
        modelId,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 2 * DAY_MS),
      });

      const res = await runSweep(app);
      expect(res.json().remindersIssued).toBe(0);
      expect(reminders).toHaveLength(0);
      expect(prisma.__transactions.filter((t) => t.status === 'PENDING')).toHaveLength(0);
    });

    it('renews on the rail the subscriber actually paid on (USD → crypto)', async () => {
      seedPaidHistory('USD');
      seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() + 1 * DAY_MS),
      });

      nock('https://nowpayments.test').post('/v1/payment').reply(200, {
        payment_id: 'np_1',
        pay_address: 'TXyz',
        pay_amount: '5.99',
        pay_currency: 'usdttrc20',
        payment_status: 'waiting',
      });

      const res = await runSweep(app);
      expect(res.json().remindersIssued).toBe(1);
      // Priced from the USD column of the catalog, not the BRL one.
      expect(reminders[0].currency).toBe('USD');
      expect(reminders[0].amountCents).toBe(599);
    });

    it('skips (and audits) a subscription with no confirmed payment to infer a rail from', async () => {
      seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() + 1 * DAY_MS),
      });

      const res = await runSweep(app);
      expect(res.json().remindersIssued).toBe(0);
      expect(
        prisma.__auditLogs.some((l) => l.action === 'subscription.renewal_skipped_no_channel'),
      ).toBe(true);
    });

    it('keeps the charge and the run going when the reminder email bounces', async () => {
      seedPaidHistory();
      seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() + 2 * DAY_MS),
      });
      (emailer.sendRenewalReminderEmail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('smtp down'),
      );

      expectWooviCharge();
      const res = await runSweep(app);

      // The charge exists and is payable — a bounced email must not undo it.
      expect(res.statusCode).toBe(200);
      expect(res.json().remindersIssued).toBe(1);
      expect(prisma.__transactions.filter((t) => t.status === 'PENDING')).toHaveLength(1);
      expect(
        prisma.__auditLogs.some((l) => l.action === 'subscription.renewal_reminder_email_failed'),
      ).toBe(true);
    });

    it('records a failed provider call without failing the sweep', async () => {
      seedPaidHistory();
      seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() + 2 * DAY_MS),
      });

      nock(WOOVI_URL)
        .post('/api/v1/subscriptions')
        .reply(200, { subscription: { globalID: 's1' } });
      nock(WOOVI_URL).post('/api/v1/charge').reply(500, { error: 'boom' });

      const res = await runSweep(app);
      expect(res.statusCode).toBe(200);
      expect(res.json().remindersIssued).toBe(0);
      expect(
        prisma.__auditLogs.some((l) => l.action === 'subscription.renewal_charge_failed'),
      ).toBe(true);
    });
  });

  // ── §2 Renewal sweep: status transitions ───────────────────────────────────
  describe('status transitions', () => {
    it('moves a lapsed non-payer to PAST_DUE, and a rerun is a no-op', async () => {
      seedPaidHistory();
      const sub = seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() - 1 * DAY_MS),
      });

      // A subscription that lapsed since the last run still gets a payable
      // charge in the same sweep that opens its grace window.
      expectWooviCharge();
      const first = await runSweep(app);
      expect(first.json().movedToPastDue).toBe(1);
      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.status).toBe('PAST_DUE');
      expect(prisma.__auditLogs.some((l) => l.action === 'subscription.past_due')).toBe(true);

      const second = await runSweep(app);
      expect(second.json()).toEqual({
        remindersIssued: 0,
        movedToPastDue: 0,
        movedToExpired: 0,
        movedToCanceled: 0,
      });
      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.status).toBe('PAST_DUE');
    });

    it('expires a PAST_DUE subscription once the grace window has elapsed', async () => {
      const sub = seedSubscription(prisma, {
        subscriberId,
        modelId,
        status: 'PAST_DUE',
        currentPeriodEnd: new Date(Date.now() - 5 * DAY_MS),
      });

      const res = await runSweep(app);
      expect(res.json().movedToExpired).toBe(1);
      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.status).toBe('EXPIRED');
      expect(prisma.__auditLogs.some((l) => l.action === 'subscription.expired')).toBe(true);

      const second = await runSweep(app);
      expect(second.json().movedToExpired).toBe(0);
    });

    it('keeps a PAST_DUE subscription inside its grace window', async () => {
      const sub = seedSubscription(prisma, {
        subscriberId,
        modelId,
        status: 'PAST_DUE',
        currentPeriodEnd: new Date(Date.now() - 1 * DAY_MS),
      });

      const res = await runSweep(app);
      expect(res.json().movedToExpired).toBe(0);
      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.status).toBe('PAST_DUE');
    });

    it('lands an opted-out subscription on CANCELED, never PAST_DUE', async () => {
      seedPaidHistory();
      const sub = seedSubscription(prisma, {
        subscriberId,
        modelId,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() - 1 * DAY_MS),
      });

      const res = await runSweep(app);
      expect(res.json()).toMatchObject({
        remindersIssued: 0,
        movedToPastDue: 0,
        movedToCanceled: 1,
      });
      // Churn and payment failure are different business signals — this row
      // must never have passed through PAST_DUE on its way here.
      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.status).toBe('CANCELED');
      expect(prisma.__auditLogs.some((l) => l.action === 'subscription.past_due')).toBe(false);
      expect(prisma.__auditLogs.some((l) => l.action === 'subscription.canceled')).toBe(true);
    });
  });

  // ── §3 The /run guard ──────────────────────────────────────────────────────
  describe('POST /api/subscriptions/renewals/run authentication', () => {
    it('rejects a missing, wrong, and near-miss secret alike', async () => {
      seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() - 1 * DAY_MS),
      });

      const missing = await app.inject({
        method: 'POST',
        url: '/api/subscriptions/renewals/run',
      });
      const wrong = await runSweep(app, 'not-the-secret');
      const nearMiss = await runSweep(app, `${CRON_SECRET}x`);

      for (const res of [missing, wrong, nearMiss]) {
        expect(res.statusCode).toBe(401);
        // The configured secret must never leak into a response body.
        expect(res.body).not.toContain(CRON_SECRET);
      }
      // Rejected before any database work: nothing transitioned.
      expect(prisma.__subscriptions[0].status).toBe('ACTIVE');
      expect(prisma.__auditLogs.some((l) => l.action.startsWith('subscription.'))).toBe(false);
    });

    it('rejects a subscriber JWT — this entrance is for the machine only', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscriptions/renewals/run',
        cookies: { access_token: subCookie },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── §4 GET /me ─────────────────────────────────────────────────────────────
  describe('GET /api/subscriptions/me', () => {
    it("returns only the caller's own subscriptions", async () => {
      seedSubscription(prisma, { subscriberId, modelId });
      // Someone else's subscription to the same model must not appear.
      seedSubscription(prisma, { subscriberId: 'u_other', modelId });

      const res = await app.inject({
        method: 'GET',
        url: '/api/subscriptions/me',
        cookies: { access_token: subCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.subscriptions).toHaveLength(1);
      expect(body.subscriptions[0]).toMatchObject({
        modelId,
        tier: 'STANDARD',
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
      });
    });

    it('401s anonymously and 403s for a model', async () => {
      const anon = await app.inject({ method: 'GET', url: '/api/subscriptions/me' });
      expect(anon.statusCode).toBe(401);

      const modelCookie = await loginAs(app, prisma, 'model', 'model2@example.com');
      const wrongRole = await app.inject({
        method: 'GET',
        url: '/api/subscriptions/me',
        cookies: { access_token: modelCookie },
      });
      expect(wrongRole.statusCode).toBe(403);
    });
  });

  // ── §5 cancel / resume ─────────────────────────────────────────────────────
  describe('cancel and resume', () => {
    const cancel = (cookie: string, target = modelId) =>
      app.inject({
        method: 'POST',
        url: `/api/subscriptions/model/${target}/cancel`,
        cookies: { access_token: cookie },
      });
    const resume = (cookie: string, target = modelId) =>
      app.inject({
        method: 'POST',
        url: `/api/subscriptions/model/${target}/resume`,
        cookies: { access_token: cookie },
      });

    it('cancels, stays ACTIVE, keeps access, and round-trips back to renewing', async () => {
      const sub = seedSubscription(prisma, {
        subscriberId,
        modelId,
        currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
      });
      const accessesBefore = prisma.__accesses.length;

      const cancelled = await cancel(subCookie);
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: true });
      // They paid for this period — nothing about their access changes.
      expect(prisma.__accesses).toHaveLength(accessesBefore);
      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.status).toBe('ACTIVE');
      expect(
        prisma.__auditLogs.filter((l) => l.action === 'subscription.cancel_requested'),
      ).toHaveLength(1);

      // Idempotent: cancelling again is a 200 no-op with no second audit row.
      const again = await cancel(subCookie);
      expect(again.statusCode).toBe(200);
      expect(again.json().cancelAtPeriodEnd).toBe(true);
      expect(
        prisma.__auditLogs.filter((l) => l.action === 'subscription.cancel_requested'),
      ).toHaveLength(1);

      const resumed = await resume(subCookie);
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: false });
      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.cancelAtPeriodEnd).toBe(false);
      expect(prisma.__auditLogs.some((l) => l.action === 'subscription.resumed')).toBe(true);
    });

    it('409s on resuming a subscription that has already moved past ACTIVE', async () => {
      seedSubscription(prisma, {
        subscriberId,
        modelId,
        status: 'PAST_DUE',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() - 1 * DAY_MS),
      });

      const res = await resume(subCookie);
      expect(res.statusCode).toBe(409);
    });

    it('404s for a model the caller has no subscription to, and for another subscriber', async () => {
      // Someone else's subscription to this model exists; the caller's does not.
      seedSubscription(prisma, { subscriberId: 'u_other', modelId });

      const cancelRes = await cancel(subCookie);
      expect(cancelRes.statusCode).toBe(404);
      const resumeRes = await resume(subCookie);
      expect(resumeRes.statusCode).toBe(404);
      // The other subscriber's row is untouched — no id substitution possible.
      expect(prisma.__subscriptions[0].cancelAtPeriodEnd).toBe(false);

      const nonexistent = await cancel(subCookie, 'u_does_not_exist');
      expect(nonexistent.statusCode).toBe(404);
      // The two 404s are indistinguishable: whether a subscription exists for
      // someone else is not the caller's to learn.
      expect(nonexistent.json()).toEqual(cancelRes.json());
    });

    it('401s anonymously and 403s for a model', async () => {
      seedSubscription(prisma, { subscriberId, modelId });

      const anon = await app.inject({
        method: 'POST',
        url: `/api/subscriptions/model/${modelId}/cancel`,
      });
      expect(anon.statusCode).toBe(401);

      const modelCookie = await loginAs(app, prisma, 'model', 'model3@example.com');
      const wrongRole = await cancel(modelCookie);
      expect(wrongRole.statusCode).toBe(403);
      expect(prisma.__subscriptions[0].cancelAtPeriodEnd).toBe(false);
    });
  });

  // ── §6 The seam: paying the reminder charge reactivates the subscription ───
  describe('paying a renewal charge (Session 05 webhook path, unchanged)', () => {
    it('brings a PAST_DUE subscription back to ACTIVE with a fresh period', async () => {
      seedPaidHistory();
      const sub = seedSubscription(prisma, {
        subscriberId,
        modelId,
        status: 'PAST_DUE',
        currentPeriodEnd: new Date(Date.now() - 1 * DAY_MS),
      });

      // Issue the renewal charge the way the sweep does. It is PAST_DUE, so the
      // sweep will not pick it up — drive checkout directly, which is the same
      // `issueSubscriptionCharge` seam.
      expectWooviCharge();
      const checkout = await app.inject({
        method: 'POST',
        url: '/api/payments/checkout/subscription',
        cookies: { access_token: subCookie },
        payload: { modelId, tier: 'STANDARD', provider: 'pix' },
      });
      const key = checkout.json().idempotencyKey as string;

      const rawBody = JSON.stringify({
        event: 'OPENPIX:CHARGE_COMPLETED',
        charge: { correlationID: key, transactionID: 'woovi_tx_renew', status: 'COMPLETED' },
      });
      const webhook = await app.inject({
        method: 'POST',
        url: '/api/payments/woovi/webhook',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': wooviSignature(rawBody),
        },
        payload: rawBody,
      });
      expect(webhook.statusCode).toBe(200);

      // No new code did this — the Session 05 upsert already reactivates on a
      // confirmed payment. The test exists to prove that seam still holds.
      const reactivated = prisma.__subscriptions.find((s) => s.id === sub.id)!;
      expect(reactivated.status).toBe('ACTIVE');
      expect(reactivated.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    });

    it('clears a standing opt-out, so a deliberate re-subscribe is not silently cancelled', async () => {
      const sub = seedSubscription(prisma, {
        subscriberId,
        modelId,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 5 * DAY_MS),
      });

      expectWooviCharge();
      const checkout = await app.inject({
        method: 'POST',
        url: '/api/payments/checkout/subscription',
        cookies: { access_token: subCookie },
        payload: { modelId, tier: 'STANDARD', provider: 'pix' },
      });
      const key = checkout.json().idempotencyKey as string;
      const rawBody = JSON.stringify({
        event: 'OPENPIX:CHARGE_COMPLETED',
        charge: { correlationID: key, transactionID: 'woovi_tx_resub', status: 'COMPLETED' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/payments/woovi/webhook',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': wooviSignature(rawBody),
        },
        payload: rawBody,
      });

      expect(prisma.__subscriptions.find((s) => s.id === sub.id)!.cancelAtPeriodEnd).toBe(false);
    });
  });
});
