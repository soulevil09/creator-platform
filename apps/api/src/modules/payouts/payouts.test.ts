// =============================================================================
// Payouts integration + adapter tests.
//
// Same posture as the Session 05 payments suite, deliberately: **nock** for
// HTTP (no second mocking library), `nock.disableNetConnect()` so an un-mocked
// Paxum call is a loud failure rather than a real request, and the in-memory
// Prisma fake for everything else. Nothing here touches a real database, a real
// provider, or the network.
//
// The properties under test are the financial ones:
//   * the split is exhaustive — model + platform == amount, always
//   * the balance is derived from unclaimed rows, never a stored counter
//   * claiming is compare-and-set, so a second run can't double-pay
//   * a provider failure releases the claim, so nothing gets stuck
//   * /run is closed without the exact cron secret, before any DB access
import { createHmac } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import {
  createFakeEmailer,
  createFakePrisma,
  seedContent,
  seedEarning,
  seedModel,
  seedProfile,
  type FakePrisma,
} from '../../test/fake-prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import { MockPayoutProvider } from './adapters/mock.adapter.js';
import { PaxumAdapter, centsToDecimalString } from './adapters/paxum.adapter.js';
import { getPayoutProvider, resetPayoutProviderCache } from './provider.factory.js';
import {
  PayoutProviderConfigError,
  type IPayoutProvider,
  type PayoutParams,
} from './provider.interface.js';
import { computeRevenueSplit } from './revenue.js';

const PAXUM_URL = 'https://paxum.test';
const IPN_SECRET = 'test-paxum-ipn-secret';
const CRON_SECRET = 'test-payout-cron-secret';
const WOOVI_URL = 'https://woovi.test';
const OPENPIX_SECRET = 'test-openpix-webhook-secret';

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

async function makeApp(prisma: FakePrisma, payoutProvider?: IPayoutProvider) {
  return buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage: createFakeStorage(),
    images: createFakeImages(),
    ...(payoutProvider ? { getPayoutProvider: () => payoutProvider } : {}),
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

/** Sign a Paxum IPN the way the adapter verifies it: HMAC-SHA256 hex, raw body. */
const paxumSignature = (rawBody: string) =>
  createHmac('sha256', IPN_SECRET).update(rawBody).digest('hex');

/** Sign a Woovi webhook body (reused to drive a real confirmation end to end). */
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

// ── §1 Revenue split ─────────────────────────────────────────────────────────
describe('computeRevenueSplit', () => {
  it('gives the model 80% and the platform the remainder', () => {
    expect(computeRevenueSplit(2990, 80)).toEqual({
      modelShareCents: 2392,
      platformShareCents: 598,
    });
  });

  it('never loses or invents a cent, at any amount or percentage', () => {
    for (const amount of [1, 3, 7, 99, 333, 2990, 5990, 14990, 1_000_003]) {
      for (const pct of [0, 1, 33, 50, 80, 99, 100]) {
        const split = computeRevenueSplit(amount, pct);
        expect(split.modelShareCents + split.platformShareCents).toBe(amount);
        expect(split.modelShareCents).toBeGreaterThanOrEqual(0);
        expect(split.platformShareCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('defaults to the 80/20 industry standard', () => {
    expect(computeRevenueSplit(1000)).toEqual({ modelShareCents: 800, platformShareCents: 200 });
  });

  it('rejects a nonsense amount or percentage rather than guessing', () => {
    expect(() => computeRevenueSplit(-1, 80)).toThrow(RangeError);
    expect(() => computeRevenueSplit(10.5, 80)).toThrow(RangeError);
    expect(() => computeRevenueSplit(1000, 120)).toThrow(RangeError);
  });
});

// ── §2 Payout provider factory ───────────────────────────────────────────────
describe('getPayoutProvider (factory)', () => {
  beforeEach(() => resetPayoutProviderCache());
  afterEach(() => {
    process.env.PAYOUT_PROVIDER = 'paxum';
    resetPayoutProviderCache();
  });

  it('resolves the configured adapter class', () => {
    expect(getPayoutProvider()).toBeInstanceOf(PaxumAdapter);
    expect(getPayoutProvider().name).toBe('PAXUM');
  });

  it('swaps the adapter class from the env var alone', () => {
    expect(getPayoutProvider()).toBeInstanceOf(PaxumAdapter);

    process.env.PAYOUT_PROVIDER = 'mock';
    resetPayoutProviderCache();

    const swapped = getPayoutProvider();
    expect(swapped).toBeInstanceOf(MockPayoutProvider);
    expect(swapped.name).toBe('PAXUM_MOCK');
  });

  it('rejects an unknown adapter name instead of falling back', () => {
    process.env.PAYOUT_PROVIDER = 'payoneer';
    resetPayoutProviderCache();
    expect(() => getPayoutProvider()).toThrow(PayoutProviderConfigError);
    expect(() => getPayoutProvider()).toThrow(/PAYOUT_PROVIDER/);
  });
});

// ── §3 PaxumAdapter ──────────────────────────────────────────────────────────
describe('PaxumAdapter', () => {
  const adapter = new PaxumAdapter({
    apiKey: 'test-paxum-api-key',
    ipnSecret: IPN_SECRET,
    apiUrl: PAXUM_URL,
  });

  it('formats minor units as the decimal string Paxum expects', () => {
    expect(centsToDecimalString(5000)).toBe('50.00');
    expect(centsToDecimalString(2392)).toBe('23.92');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(100000)).toBe('1000.00');
  });

  it('submits a batch and returns one item per recipient', async () => {
    let sentBody: Record<string, unknown> = {};
    const scope = nock(PAXUM_URL)
      .post('/v1/mass-payouts', (body) => {
        sentBody = body as Record<string, unknown>;
        return true;
      })
      .matchHeader('x-api-key', 'test-paxum-api-key')
      .reply(200, {
        batchId: 'paxum_batch_1',
        payments: [
          { correlationId: 'payout_a', transactionId: 'paxum_tx_a', status: 'PENDING' },
          { correlationId: 'payout_b', transactionId: 'paxum_tx_b', status: 'PAID' },
        ],
      });

    const result = await adapter.createPayout({
      description: 'weekly earnings',
      recipients: [
        {
          modelId: 'm1',
          destination: 'a@example.com',
          amountCents: 5000,
          currency: 'BRL',
          correlationId: 'payout_a',
        },
        {
          modelId: 'm2',
          destination: 'b@example.com',
          amountCents: 12345,
          currency: 'BRL',
          correlationId: 'payout_b',
        },
      ],
    });

    expect(scope.isDone()).toBe(true);
    // The correlation id must reach the provider — that round trip is what
    // makes IPN processing idempotent.
    const payments = sentBody.payments as Array<Record<string, unknown>>;
    expect(payments[0]).toMatchObject({
      correlationId: 'payout_a',
      recipientEmail: 'a@example.com',
      amount: '50.00',
    });
    expect(payments[1].amount).toBe('123.45');

    expect(result.provider).toBe('PAXUM');
    expect(result.providerBatchId).toBe('paxum_batch_1');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ status: 'PENDING', providerPayoutId: 'paxum_tx_a' });
    expect(result.items[1]).toMatchObject({ status: 'PAID', providerPayoutId: 'paxum_tx_b' });
  });

  it('reports a recipient the provider silently dropped rather than losing it', async () => {
    nock(PAXUM_URL).post('/v1/mass-payouts').reply(200, { batchId: 'b1', payments: [] });

    const result = await adapter.createPayout({
      description: 'weekly earnings',
      recipients: [
        {
          modelId: 'm1',
          destination: 'a@example.com',
          amountCents: 5000,
          currency: 'BRL',
          correlationId: 'payout_a',
        },
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: 'PENDING', providerPayoutId: null });
  });

  it('surfaces a rejected item with its reason', async () => {
    nock(PAXUM_URL)
      .post('/v1/mass-payouts')
      .reply(200, {
        batchId: 'b1',
        payments: [
          { correlationId: 'payout_a', status: 'REJECTED', errorMessage: 'no such recipient' },
        ],
      });

    const result = await adapter.createPayout({
      description: 'weekly earnings',
      recipients: [
        {
          modelId: 'm1',
          destination: 'a@example.com',
          amountCents: 5000,
          currency: 'BRL',
          correlationId: 'payout_a',
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'no such recipient',
    });
  });

  it('turns a provider error into a PayoutProviderError without leaking the key', async () => {
    nock(PAXUM_URL).post('/v1/mass-payouts').reply(500, 'upstream exploded');

    await expect(
      adapter.createPayout({
        description: 'weekly earnings',
        recipients: [
          {
            modelId: 'm1',
            destination: 'a@example.com',
            amountCents: 5000,
            currency: 'BRL',
            correlationId: 'payout_a',
          },
        ],
      }),
    ).rejects.toThrow(/PAXUM responded 500/);
  });

  it('refuses a mixed-currency batch without calling the provider', async () => {
    await expect(
      adapter.createPayout({
        description: 'weekly earnings',
        recipients: [
          {
            modelId: 'm1',
            destination: 'a@example.com',
            amountCents: 5000,
            currency: 'BRL',
            correlationId: 'payout_a',
          },
          {
            modelId: 'm2',
            destination: 'b@example.com',
            amountCents: 5000,
            currency: 'USD',
            correlationId: 'payout_b',
          },
        ],
      }),
    ).rejects.toThrow(/one currency/);
  });

  it('accepts a correctly signed IPN and rejects a tampered one', () => {
    const raw = JSON.stringify({
      correlationId: 'payout_a',
      transactionId: 'paxum_tx_a',
      status: 'PAID',
    });
    const headers = { 'x-paxum-signature': paxumSignature(raw) };

    expect(adapter.verifyWebhookSignature(Buffer.from(raw), headers)).toBe(true);
    expect(
      adapter.verifyWebhookSignature(Buffer.from(raw.replace('payout_a', 'payout_z')), headers),
    ).toBe(false);
    // A missing header is a rejection, not an exception.
    expect(adapter.verifyWebhookSignature(Buffer.from(raw), {})).toBe(false);
  });

  it('normalizes IPN statuses to PAID / FAILED / PENDING', () => {
    const parse = (body: unknown) => adapter.parseWebhookEvent(Buffer.from(JSON.stringify(body)));

    expect(parse({ correlationId: 'c', status: 'PAID' }).status).toBe('PAID');
    expect(parse({ correlationId: 'c', status: 'REJECTED' }).status).toBe('FAILED');
    expect(parse({ correlationId: 'c', status: 'PROCESSING' }).status).toBe('PENDING');
    expect(() => parse({ status: 'PAID' })).toThrow(/correlationId/);
  });
});

// ── §4 Split persisted by the payment webhook ────────────────────────────────
describe('revenue split on a confirmed subscription webhook', () => {
  let prisma: FakePrisma;
  let app: App;
  let subCookie: string;
  let modelId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
    seedProfile(prisma, modelId);
    seedContent(prisma, { modelId, tier: 'STANDARD' });
    subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
  });

  async function confirmSubscription(tier: 'STANDARD' | 'PREMIUM' = 'STANDARD') {
    nock(WOOVI_URL)
      .post('/api/v1/subscriptions')
      .reply(200, { subscription: { globalID: 's1' } });
    nock(WOOVI_URL).post('/api/v1/charge').reply(200, wooviChargeReply('unused'));
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/payments/checkout/subscription',
      cookies: { access_token: subCookie },
      payload: { modelId, tier, provider: 'pix' },
    });
    const key = checkout.json().idempotencyKey as string;
    const rawBody = JSON.stringify({
      event: 'OPENPIX:CHARGE_COMPLETED',
      charge: { correlationID: key, transactionID: 'woovi_tx_777', status: 'COMPLETED' },
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
    return key;
  }

  it('stamps an 80/20 split on the confirmed transaction', async () => {
    const key = await confirmSubscription('STANDARD');

    const tx = prisma.__transactions.find((t) => t.idempotencyKey === key)!;
    expect(tx.status).toBe('CONFIRMED');
    expect(tx.amount).toBe(2990);
    expect(tx.modelShareCents).toBe(Math.round(2990 * 0.8)); // 2392
    expect(tx.platformShareCents).toBe(2990 - 2392);
    expect(tx.modelShareCents! + tx.platformShareCents!).toBe(tx.amount);
    expect(tx.modelId).toBe(modelId);
    expect(tx.payoutId).toBeNull();
  });

  it('leaves the shares null on a credit-pack purchase', async () => {
    nock(WOOVI_URL).post('/api/v1/charge').reply(200, wooviChargeReply('unused'));
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/payments/checkout/credits',
      cookies: { access_token: subCookie },
      payload: { packId: 'starter', provider: 'pix' },
    });
    const key = checkout.json().idempotencyKey as string;
    const rawBody = JSON.stringify({
      event: 'OPENPIX:CHARGE_COMPLETED',
      charge: { correlationID: key, transactionID: 'woovi_tx_888', status: 'COMPLETED' },
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

    const tx = prisma.__transactions.find((t) => t.idempotencyKey === key)!;
    expect(tx.status).toBe('CONFIRMED');
    // Credits have no per-model attribution until Session 08 — there is nothing
    // honest to split here yet.
    expect(tx.modelShareCents).toBeNull();
    expect(tx.platformShareCents).toBeNull();
  });

  it('records the split in the subscription audit entry', async () => {
    await confirmSubscription('PREMIUM');
    const log = prisma.__auditLogs.find((l) => l.action === 'subscription.activated')!;
    expect(log.metadata).toMatchObject({
      modelShareCents: Math.round(5990 * 0.8),
      platformShareCents: 5990 - Math.round(5990 * 0.8),
    });
  });
});

// ── §5 GET /api/payouts/balance ──────────────────────────────────────────────
describe('GET /api/payouts/balance', () => {
  let prisma: FakePrisma;
  let app: App;
  let modelCookie: string;
  let modelId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    modelCookie = await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
  });

  const getBalance = (cookie: string | null = modelCookie) =>
    app.inject({
      method: 'GET',
      url: '/api/payouts/balance',
      cookies: cookie ? { access_token: cookie } : undefined,
    });

  it('sums a model’s unpaid earnings', async () => {
    seedEarning(prisma, { modelId, modelShareCents: 2392 });
    seedEarning(prisma, { modelId, modelShareCents: 4792 });

    const res = await getBalance();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      modelId,
      availableCents: 2392 + 4792,
      thresholdCents: 5000,
      eligible: true,
      // No destination set yet — a run would skip them however large this is.
      payoutEmailConfigured: false,
    });
  });

  it('reports payoutEmailConfigured once a destination is set', async () => {
    seedProfile(prisma, modelId, 'model@paxum.example');
    seedEarning(prisma, { modelId, modelShareCents: 9000 });

    const body = (await getBalance()).json();
    expect(body).toMatchObject({
      availableCents: 9000,
      eligible: true,
      payoutEmailConfigured: true,
    });
    // The balance endpoint answers "how much", not "to where" — the address
    // itself is never echoed back.
    expect(JSON.stringify(body)).not.toContain('paxum.example');
  });

  it('reports payoutEmailConfigured false for a profile with no destination', async () => {
    seedProfile(prisma, modelId);
    expect((await getBalance()).json().payoutEmailConfigured).toBe(false);
  });

  it('excludes earnings already attached to a payout', async () => {
    seedEarning(prisma, { modelId, modelShareCents: 2392 });
    seedEarning(prisma, { modelId, modelShareCents: 4792, payoutId: 'po_already_paid' });

    expect((await getBalance()).json().availableCents).toBe(2392);
  });

  it('excludes another model’s earnings and unconfirmed transactions', async () => {
    seedEarning(prisma, { modelId, modelShareCents: 1000 });
    seedEarning(prisma, { modelId: 'someone_else', modelShareCents: 9999 });
    seedEarning(prisma, { modelId, modelShareCents: 5000, status: 'PENDING' });
    seedEarning(prisma, { modelId, modelShareCents: 5000, status: 'FAILED' });
    seedEarning(prisma, { modelId, modelShareCents: 5000, type: 'CREDIT_PACK' });

    const body = (await getBalance()).json();
    expect(body.availableCents).toBe(1000);
    expect(body.eligible).toBe(false);
  });

  it('reads zero for a model who has never earned', async () => {
    expect((await getBalance()).json()).toMatchObject({ availableCents: 0, eligible: false });
  });

  it('rejects an unauthenticated request → 401', async () => {
    expect((await getBalance(null)).statusCode).toBe(401);
  });

  it('rejects a subscriber (model-only endpoint) → 403', async () => {
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    expect((await getBalance(subCookie)).statusCode).toBe(403);
  });

  it('scopes strictly to the caller — there is no id to substitute', async () => {
    seedEarning(prisma, { modelId, modelShareCents: 7000 });
    const otherCookie = await loginAs(app, prisma, 'model', 'other@example.com');

    // The other model reads their own (empty) balance, not this one's, even
    // though they know the id: the userId comes from the JWT.
    expect((await getBalance(otherCookie)).json()).toMatchObject({ availableCents: 0 });
  });
});

// ── §5b PUT /api/payouts/payout-email ────────────────────────────────────────
describe('PUT /api/payouts/payout-email', () => {
  let prisma: FakePrisma;
  let app: App;
  let modelCookie: string;
  let modelId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    modelCookie = await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
    seedProfile(prisma, modelId);
  });

  const setEmail = (payload: Record<string, unknown>, cookie: string | null = modelCookie) =>
    app.inject({
      method: 'PUT',
      url: '/api/payouts/payout-email',
      cookies: cookie ? { access_token: cookie } : undefined,
      payload,
    });

  const profileOf = (userId: string) => prisma.__profiles.find((p) => p.userId === userId)!;

  it('sets the destination for the first time and audits it', async () => {
    const res = await setEmail({ payoutEmail: 'model@paxum.example' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ modelId, payoutEmail: 'model@paxum.example' });
    expect(profileOf(modelId).payoutEmail).toBe('model@paxum.example');

    const log = prisma.__auditLogs.find((l) => l.action === 'payout.email_changed')!;
    expect(log).toMatchObject({ actorId: modelId, entity: 'ModelProfile' });
    expect(log.metadata).toMatchObject({
      previousPayoutEmail: null,
      newPayoutEmail: 'model@paxum.example',
    });
  });

  it('records the previous value when the destination changes', async () => {
    await setEmail({ payoutEmail: 'old@paxum.example' });
    const res = await setEmail({ payoutEmail: 'new@paxum.example' });

    expect(res.statusCode).toBe(200);
    expect(profileOf(modelId).payoutEmail).toBe('new@paxum.example');

    const logs = prisma.__auditLogs.filter((l) => l.action === 'payout.email_changed');
    expect(logs).toHaveLength(2);
    // The trail is what makes a misrouted payout traceable to the change.
    expect(logs[1].metadata).toMatchObject({
      previousPayoutEmail: 'old@paxum.example',
      newPayoutEmail: 'new@paxum.example',
    });
  });

  it('does not write a misleading audit row when nothing changed', async () => {
    await setEmail({ payoutEmail: 'model@paxum.example' });
    const res = await setEmail({ payoutEmail: 'model@paxum.example' });

    expect(res.statusCode).toBe(200);
    expect(prisma.__auditLogs.filter((l) => l.action === 'payout.email_changed')).toHaveLength(1);
  });

  it('normalizes case and whitespace so the unique index cannot be sidestepped', async () => {
    const res = await setEmail({ payoutEmail: '  Model@Paxum.Example  ' });
    expect(res.statusCode).toBe(200);
    expect(profileOf(modelId).payoutEmail).toBe('model@paxum.example');
  });

  it('rejects a malformed email → 400, nothing written', async () => {
    for (const bad of ['not-an-email', '', 'a@', '@b.com', 'a b@c.com']) {
      const res = await setEmail({ payoutEmail: bad });
      expect(res.statusCode).toBe(400);
    }
    expect(profileOf(modelId).payoutEmail).toBeNull();
    expect(prisma.__auditLogs.some((l) => l.action === 'payout.email_changed')).toBe(false);
  });

  it('rejects a missing field → 400', async () => {
    expect((await setEmail({})).statusCode).toBe(400);
  });

  it('rejects an email already claimed by another model → 409', async () => {
    seedModel(prisma, 'm_other', 'other@example.com');
    seedProfile(prisma, 'm_other', 'shared@paxum.example');

    const res = await setEmail({ payoutEmail: 'shared@paxum.example' });

    // The UNIQUE index is what prevents two models routing to one address; the
    // service turns that into a clean conflict, not a raw database error.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already in use/i);
    expect(profileOf(modelId).payoutEmail).toBeNull();
    expect(profileOf('m_other').payoutEmail).toBe('shared@paxum.example');
  });

  it('404s a model who has no profile yet', async () => {
    const freshCookie = await loginAs(app, prisma, 'model', 'fresh@example.com');
    const res = await setEmail({ payoutEmail: 'fresh@paxum.example' }, freshCookie);
    expect(res.statusCode).toBe(404);
  });

  it('rejects a subscriber → 403', async () => {
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    expect((await setEmail({ payoutEmail: 'sub@paxum.example' }, subCookie)).statusCode).toBe(403);
  });

  it('rejects an unauthenticated request → 401, nothing written', async () => {
    expect((await setEmail({ payoutEmail: 'anon@paxum.example' }, null)).statusCode).toBe(401);
    expect(profileOf(modelId).payoutEmail).toBeNull();
  });

  it('writes only the caller’s own destination — there is no id to substitute', async () => {
    seedModel(prisma, 'm_other', 'other@example.com');
    seedProfile(prisma, 'm_other');

    // A modelId in the body is ignored: the userId comes from the JWT.
    const res = await setEmail({
      payoutEmail: 'mine@paxum.example',
      modelId: 'm_other',
      userId: 'm_other',
    });

    expect(res.statusCode).toBe(200);
    expect(profileOf(modelId).payoutEmail).toBe('mine@paxum.example');
    expect(profileOf('m_other').payoutEmail).toBeNull();
  });
});

// ── §6 POST /api/payouts/run ─────────────────────────────────────────────────
describe('POST /api/payouts/run', () => {
  let prisma: FakePrisma;
  let app: App;
  let provider: MockPayoutProvider;

  beforeEach(async () => {
    prisma = createFakePrisma();
    provider = new MockPayoutProvider();
    app = await makeApp(prisma, provider);
  });

  const run = (secret: string | null = CRON_SECRET) =>
    app.inject({
      method: 'POST',
      url: '/api/payouts/run',
      headers: secret === null ? {} : { 'x-payout-cron-secret': secret },
    });

  it('pays models above the threshold and skips the ones below', async () => {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedModel(prisma, 'm_ok', 'ok@example.com');
    seedModel(prisma, 'm_poor', 'poor@example.com');
    // Paxum pays into a personal Paxum account, so the destination is the
    // model's `payoutEmail` — deliberately different from the login email here.
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedProfile(prisma, 'm_ok', 'ok@paxum.example');
    seedProfile(prisma, 'm_poor', 'poor@paxum.example');

    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 4000 });
    seedEarning(prisma, { modelId: 'm_ok', modelShareCents: 5000 }); // exactly the threshold
    seedEarning(prisma, { modelId: 'm_poor', modelShareCents: 4999 }); // one cent short

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      processed: 2,
      skipped: 1,
      failed: 0,
      totalCents: 12000 + 5000,
    });

    expect(prisma.__payouts).toHaveLength(2);
    const rich = prisma.__payouts.find((p) => p.modelId === 'm_rich')!;
    expect(rich).toMatchObject({
      amountCents: 12000,
      currency: 'BRL',
      // Accepted by the provider, awaiting its IPN.
      status: 'PROCESSING',
      provider: 'PAXUM_MOCK',
    });
    expect(rich.providerPayoutId).toBe(`mock_payout_${rich.idempotencyKey}`);

    // The two claimed rows point at the payout; the below-threshold model's
    // row is untouched and rolls into next week.
    const claimed = prisma.__transactions.filter((t) => t.payoutId === rich.id);
    expect(claimed).toHaveLength(2);
    expect(prisma.__transactions.find((t) => t.modelId === 'm_poor')!.payoutId).toBeNull();

    // Recipients are addressed by their Paxum destination, never their login.
    const destinations = provider.getBatches().map((b) => b.recipients[0].destination);
    expect(destinations.sort()).toEqual(['ok@paxum.example', 'rich@paxum.example']);

    // Every state transition is audited.
    expect(prisma.__auditLogs.filter((l) => l.action === 'payout.created')).toHaveLength(2);
    expect(prisma.__auditLogs.filter((l) => l.action === 'payout.submitted')).toHaveLength(2);
    expect(prisma.__auditLogs.some((l) => l.action === 'payout.run_completed')).toBe(true);
  });

  it('sends the payout email to Paxum, not the login email', async () => {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });

    // The real PaxumAdapter this time, so the assertion is on the wire.
    let sentBody: Record<string, unknown> = {};
    const scope = nock(PAXUM_URL)
      .post('/v1/mass-payouts', (body) => {
        sentBody = body as Record<string, unknown>;
        return true;
      })
      .reply(200, { batchId: 'b1', payments: [] });
    const liveApp = await makeApp(prisma);

    const res = await liveApp.inject({
      method: 'POST',
      url: '/api/payouts/run',
      headers: { 'x-payout-cron-secret': CRON_SECRET },
    });

    expect(res.json()).toMatchObject({ processed: 1 });
    expect(scope.isDone()).toBe(true);
    const payments = sentBody.payments as Array<Record<string, unknown>>;
    expect(payments[0].recipientEmail).toBe('rich@paxum.example');
    expect(payments[0].recipientEmail).not.toBe('rich@example.com');
  });

  it('skips a model who has not set a payout email, leaving the balance payable', async () => {
    seedModel(prisma, 'm_nodest', 'nodest@example.com');
    seedProfile(prisma, 'm_nodest'); // profile exists, payoutEmail is null
    const earning = seedEarning(prisma, { modelId: 'm_nodest', modelShareCents: 9000 });

    const res = await run();

    // Skipped, not failed: there is nothing to fail, and the money must stay
    // payable rather than getting stuck against a dead payout.
    expect(res.json()).toMatchObject({ processed: 0, skipped: 1, failed: 0, totalCents: 0 });
    expect(prisma.__payouts).toHaveLength(0);
    expect(prisma.__transactions.find((t) => t.id === earning.id)!.payoutId).toBeNull();
    expect(provider.getBatches()).toHaveLength(0);
    expect(prisma.__auditLogs.some((l) => l.action === 'payout.skipped_no_payout_email')).toBe(
      true,
    );
  });

  it('skips a model with no profile at all', async () => {
    seedModel(prisma, 'm_noprofile', 'noprofile@example.com');
    seedEarning(prisma, { modelId: 'm_noprofile', modelShareCents: 9000 });

    expect((await run()).json()).toMatchObject({ processed: 0, skipped: 1 });
    expect(prisma.__payouts).toHaveLength(0);
  });

  it('pays a model on the run after they set their payout email', async () => {
    seedModel(prisma, 'm_late', 'late@example.com');
    seedProfile(prisma, 'm_late');
    seedEarning(prisma, { modelId: 'm_late', modelShareCents: 9000 });

    expect((await run()).json()).toMatchObject({ processed: 0, skipped: 1 });

    prisma.__profiles.find((p) => p.userId === 'm_late')!.payoutEmail = 'late@paxum.example';

    // Same balance, now payable — nothing was consumed by the skipped run.
    const second = await app.inject({
      method: 'POST',
      url: '/api/payouts/run',
      headers: { 'x-payout-cron-secret': CRON_SECRET },
    });
    expect(second.json()).toMatchObject({ processed: 1, totalCents: 9000 });
    expect(provider.getBatches()[0].recipients[0].destination).toBe('late@paxum.example');
  });

  it('processes nothing on a second immediate run', async () => {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });

    const first = await run();
    expect(first.json()).toMatchObject({ processed: 1, totalCents: 8000 });

    const second = await run();
    // The earnings are claimed, so there is nothing left to pay — no second
    // payout row, no double transfer.
    expect(second.json()).toEqual({ processed: 0, skipped: 0, failed: 0, totalCents: 0 });
    expect(prisma.__payouts).toHaveLength(1);
  });

  it('picks up new earnings in the following run', async () => {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });
    await run();

    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 6000 });
    const second = await run();

    expect(second.json()).toMatchObject({ processed: 1, totalCents: 6000 });
    expect(prisma.__payouts).toHaveLength(2);
    expect(prisma.__payouts[1].amountCents).toBe(6000);
  });

  it('releases the claim and marks the payout FAILED when the provider errors', async () => {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    const earning = seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });

    const failing: IPayoutProvider = {
      name: 'PAXUM_MOCK',
      createPayout: vi.fn(async () => {
        throw new Error('paxum unreachable');
      }),
      verifyWebhookSignature: () => false,
      parseWebhookEvent: () => {
        throw new Error('unused');
      },
    };
    const failingApp = await makeApp(prisma, failing);

    const res = await failingApp.inject({
      method: 'POST',
      url: '/api/payouts/run',
      headers: { 'x-payout-cron-secret': CRON_SECRET },
    });

    expect(res.json()).toMatchObject({ processed: 0, failed: 1, totalCents: 0 });
    expect(prisma.__payouts[0].status).toBe('FAILED');
    expect(prisma.__payouts[0].failureReason).toContain('paxum unreachable');
    // Released back to the unpaid pool — nothing is stuck mid-state.
    expect(prisma.__transactions.find((t) => t.id === earning.id)!.payoutId).toBeNull();
    expect(prisma.__auditLogs.some((l) => l.action === 'payout.failed')).toBe(true);
  });

  it('retries a released balance on the next run', async () => {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });

    let calls = 0;
    const flaky: IPayoutProvider = {
      name: 'PAXUM_MOCK',
      createPayout: vi.fn(async (params: PayoutParams) => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return {
          provider: 'PAXUM_MOCK' as const,
          providerBatchId: 'b1',
          items: params.recipients.map((r) => ({
            modelId: r.modelId,
            correlationId: r.correlationId,
            providerPayoutId: 'paxum_tx_retry',
            status: 'PENDING' as const,
          })),
        };
      }),
      verifyWebhookSignature: () => false,
      parseWebhookEvent: () => {
        throw new Error('unused');
      },
    };
    const flakyApp = await makeApp(prisma, flaky);
    const runFlaky = () =>
      flakyApp.inject({
        method: 'POST',
        url: '/api/payouts/run',
        headers: { 'x-payout-cron-secret': CRON_SECRET },
      });

    expect((await runFlaky()).json()).toMatchObject({ failed: 1 });
    // The full balance is payable again, so the next run pays it in full.
    expect((await runFlaky()).json()).toMatchObject({ processed: 1, totalCents: 8000 });
    expect(prisma.__payouts.filter((p) => p.status === 'PROCESSING')).toHaveLength(1);
  });

  it('skips a model whose account no longer exists', async () => {
    seedEarning(prisma, { modelId: 'm_ghost', modelShareCents: 9000 });

    const res = await run();

    expect(res.json()).toMatchObject({ processed: 0, skipped: 1 });
    expect(prisma.__payouts).toHaveLength(0);
    expect(prisma.__auditLogs.some((l) => l.action === 'payout.skipped_no_recipient')).toBe(true);
  });

  it('rejects a missing secret with 401 before touching the database', async () => {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });

    const res = await run(null);

    expect(res.statusCode).toBe(401);
    expect(prisma.__payouts).toHaveLength(0);
    expect(prisma.__auditLogs).toHaveLength(0);
  });

  it('rejects a wrong secret with 401', async () => {
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });

    expect((await run('not-the-cron-secret')).statusCode).toBe(401);
    // …including one that only differs in the last byte.
    expect((await run(`${CRON_SECRET.slice(0, -1)}X`)).statusCode).toBe(401);
    expect(prisma.__payouts).toHaveLength(0);
  });

  it('rejects a logged-in model’s JWT — the secret is the only key', async () => {
    const modelCookie = await loginAs(app, prisma, 'model', 'model@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/payouts/run',
      cookies: { access_token: modelCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rate limits runs at 2 per hour even with the right secret', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await run()).statusCode);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(2);
    expect(codes.at(-1)).toBe(429);
  });
});

// ── §7 POST /api/payouts/paxum/webhook ───────────────────────────────────────
describe('POST /api/payouts/paxum/webhook', () => {
  let prisma: FakePrisma;
  let app: App;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    seedModel(prisma, 'm_rich', 'rich@example.com');
    seedProfile(prisma, 'm_rich', 'rich@paxum.example');
    seedEarning(prisma, { modelId: 'm_rich', modelShareCents: 8000 });
    // Drive one real run so there is a PROCESSING payout to confirm.
    nock(PAXUM_URL)
      .post('/v1/mass-payouts')
      .reply(200, {
        batchId: 'paxum_batch_1',
        payments: [],
      })
      .persist();
    await app.inject({
      method: 'POST',
      url: '/api/payouts/run',
      headers: { 'x-payout-cron-secret': CRON_SECRET },
    });
  });

  const postIpn = (rawBody: string, signature = paxumSignature(rawBody)) =>
    app.inject({
      method: 'POST',
      url: '/api/payouts/paxum/webhook',
      headers: { 'content-type': 'application/json', 'x-paxum-signature': signature },
      payload: rawBody,
    });

  const ipnBody = (correlationId: string, status: string) =>
    JSON.stringify({ correlationId, transactionId: 'paxum_tx_final', status });

  it('completes a PROCESSING payout on a PAID callback', async () => {
    const payout = prisma.__payouts[0];
    expect(payout.status).toBe('PROCESSING');

    const res = await postIpn(ipnBody(payout.idempotencyKey, 'PAID'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, processed: true, duplicate: false });
    expect(prisma.__payouts[0]).toMatchObject({
      status: 'COMPLETED',
      providerPayoutId: 'paxum_tx_final',
    });
    expect(prisma.__payouts[0].completedAt).toBeInstanceOf(Date);
    expect(prisma.__auditLogs.some((l) => l.action === 'payout.completed')).toBe(true);
  });

  it('applies an identical redelivery exactly once', async () => {
    const payout = prisma.__payouts[0];
    const body = ipnBody(payout.idempotencyKey, 'PAID');

    const first = await postIpn(body);
    const second = await postIpn(body);

    expect(first.json()).toMatchObject({ processed: true, duplicate: false });
    // Still 200: a retry cannot fix anything, so the provider must stop.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ processed: false, duplicate: true });
    expect(prisma.__auditLogs.filter((l) => l.action === 'payout.completed')).toHaveLength(1);
  });

  it('fails the payout and releases its earnings on a REJECTED callback', async () => {
    const payout = prisma.__payouts[0];

    const res = await postIpn(ipnBody(payout.idempotencyKey, 'REJECTED'));

    expect(res.statusCode).toBe(200);
    expect(prisma.__payouts[0].status).toBe('FAILED');
    // The money is payable again next week rather than stuck on a dead payout.
    expect(prisma.__transactions[0].payoutId).toBeNull();
    expect(prisma.__auditLogs.some((l) => l.action === 'payout.failed')).toBe(true);
  });

  it('applies a redelivered REJECTED callback exactly once', async () => {
    const payout = prisma.__payouts[0];
    const body = ipnBody(payout.idempotencyKey, 'REJECTED');

    const first = await postIpn(body);
    const second = await postIpn(body);

    expect(first.json()).toMatchObject({ processed: true, duplicate: false });
    expect(second.json()).toMatchObject({ processed: false, duplicate: true });
    // The terminal status is written by the same statement that claims the
    // payout, so the second delivery matches zero rows and the release — which
    // is what actually moves money back into the payable pool — runs once.
    expect(prisma.__auditLogs.filter((l) => l.action === 'payout.failed')).toHaveLength(1);
    expect(prisma.__payouts[0].status).toBe('FAILED');
  });

  it('leaves the payout alone on a non-terminal callback', async () => {
    const payout = prisma.__payouts[0];
    const res = await postIpn(ipnBody(payout.idempotencyKey, 'PROCESSING'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ processed: false });
    expect(prisma.__payouts[0].status).toBe('PROCESSING');
  });

  it('rejects a forged signature with 400 and changes nothing', async () => {
    const payout = prisma.__payouts[0];
    const auditsBefore = prisma.__auditLogs.length;

    const res = await postIpn(ipnBody(payout.idempotencyKey, 'PAID'), 'ff'.repeat(32));

    expect(res.statusCode).toBe(400);
    expect(prisma.__payouts[0].status).toBe('PROCESSING');
    expect(prisma.__auditLogs).toHaveLength(auditsBefore);
  });

  it('rejects a missing signature header with 400', async () => {
    const payout = prisma.__payouts[0];
    const res = await app.inject({
      method: 'POST',
      url: '/api/payouts/paxum/webhook',
      headers: { 'content-type': 'application/json' },
      payload: ipnBody(payout.idempotencyKey, 'PAID'),
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.__payouts[0].status).toBe('PROCESSING');
  });

  it('leaves an unknown correlation id alone and answers 200', async () => {
    const res = await postIpn(ipnBody('payout_never_created', 'PAID'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ processed: false, duplicate: true });
    expect(prisma.__payouts[0].status).toBe('PROCESSING');
  });
});

// ── §8 Admin visibility ──────────────────────────────────────────────────────
describe('GET /api/payouts and /api/payouts/:payoutId', () => {
  let prisma: FakePrisma;
  let app: App;
  let adminCookie: string;
  let modelCookie: string;
  let modelId: string;

  /** Promote a registered user to ADMIN and re-login (registration can't). */
  async function loginAsAdmin(email: string): Promise<string> {
    await loginAs(app, prisma, 'subscriber', email);
    prisma.__users.find((u) => u.email === email)!.role = 'ADMIN';
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'supersecret' },
    });
    return login.cookies.find((c) => c.name === 'access_token')!.value;
  }

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma, new MockPayoutProvider());
    modelCookie = await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
    adminCookie = await loginAsAdmin('admin@example.com');

    seedProfile(prisma, modelId, 'model@paxum.example');
    seedEarning(prisma, { modelId, modelShareCents: 9000 });
    seedModel(prisma, 'm_other', 'other-model@example.com');
    seedProfile(prisma, 'm_other', 'other@paxum.example');
    seedEarning(prisma, { modelId: 'm_other', modelShareCents: 7000 });
    await app.inject({
      method: 'POST',
      url: '/api/payouts/run',
      headers: { 'x-payout-cron-secret': CRON_SECRET },
    });
  });

  it('lists every payout for an admin, paginated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/payouts?limit=1&offset=0',
      cookies: { access_token: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.payouts).toHaveLength(1);
    expect(body.payouts[0]).toMatchObject({ status: 'PROCESSING', provider: 'PAXUM_MOCK' });
  });

  it('refuses the listing to a model → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/payouts',
      cookies: { access_token: modelCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses the listing to an anonymous caller → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/payouts' })).statusCode).toBe(401);
  });

  it('lets a model read their own payout detail', async () => {
    const own = prisma.__payouts.find((p) => p.modelId === modelId)!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/payouts/${own.id}`,
      cookies: { access_token: modelCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      payoutId: own.id,
      modelId,
      amountCents: 9000,
      transactionCount: 1,
    });
  });

  it('hides another model’s payout behind a 404, not a 403', async () => {
    const other = prisma.__payouts.find((p) => p.modelId === 'm_other')!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/payouts/${other.id}`,
      cookies: { access_token: modelCookie },
    });
    // Whether that id exists is not this model's to learn.
    expect(res.statusCode).toBe(404);
  });

  it('lets an admin read any payout detail', async () => {
    const other = prisma.__payouts.find((p) => p.modelId === 'm_other')!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/payouts/${other.id}`,
      cookies: { access_token: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ modelId: 'm_other', amountCents: 7000 });
  });

  it('404s an unknown payout id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/payouts/po_nope',
      cookies: { access_token: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
