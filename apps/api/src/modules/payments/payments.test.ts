// =============================================================================
// Payments integration + adapter tests.
//
// HTTP mocking: **nock**, not msw.
//   * nock@14 intercepts Node's global `fetch` natively, which is exactly the
//     surface the adapters use — no extra transport shim.
//   * `nock.disableNetConnect()` turns any un-mocked provider call into a loud
//     failure, so the suite cannot silently reach api.woovi.com. msw's
//     `onUnhandledRequest` gives the same guarantee but needs a server
//     lifecycle and a handler registry we would only ever use in one file.
//   * The adapters are plain HTTP clients, not browser code; msw's real value
//     (sharing handlers between a browser worker and Node) does not apply.
//
// Idempotency is asserted the way it is enforced: the DB unique constraint on
// `PaymentTransaction.idempotencyKey` plus a conditional confirm. There is a
// direct test that a duplicate insert rejects, and tests that replaying an
// identical webhook leaves wallet and subscription state unchanged.
//
// Nothing here touches a real database, a real provider, or the network.
import { createHmac } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import {
  createFakeEmailer,
  createFakePrisma,
  FakeUniqueConstraintError,
  seedContent,
  seedProfile,
  type FakePrisma,
} from '../../test/fake-prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import { MockPaymentProvider } from './adapters/mock.adapter.js';
import { NOWPaymentsAdapter, sortedJsonStringify } from './adapters/nowpayments.adapter.js';
import { WooviPixAdapter } from './adapters/woovi.adapter.js';
import { getPaymentProvider, resetPaymentProviderCache } from './provider.factory.js';
import { PaymentProviderConfigError } from './provider.interface.js';

const WOOVI_URL = 'https://woovi.test';
const NOWPAYMENTS_URL = 'https://nowpayments.test';
const OPENPIX_SECRET = 'test-openpix-webhook-secret';
const IPN_SECRET = 'test-nowpayments-ipn-secret';

// ── Fakes for the non-payment dependencies buildServer still needs ───────────
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

async function makeApp(prisma: FakePrisma) {
  return buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
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

// ── Provider payload builders ────────────────────────────────────────────────
const wooviChargeReply = (correlationId: string) => ({
  charge: {
    correlationID: correlationId,
    transactionID: 'woovi_tx_123',
    status: 'ACTIVE',
    value: 2990,
    brCode: '00020126580014BR.GOV.BCB.PIX0136copia-e-cola-payload6304ABCD',
    qrCodeImage: 'https://api.woovi.com/openpix/charge/brcode/image/abc.png',
    paymentLinkUrl: 'https://woovi.com/pay/abc',
    expiresDate: '2026-08-30T13:00:00.000Z',
  },
});

const nowPaymentsReply = (correlationId: string) => ({
  payment_id: 987654321,
  payment_status: 'waiting',
  pay_address: 'TXyz1234567890abcdefghijklmnopqrs',
  pay_amount: '3.99123456',
  pay_currency: 'usdttrc20',
  payin_extra_id: null,
  order_id: correlationId,
});

/** Sign a Woovi webhook body the way the adapter expects to verify it. */
function wooviSignature(rawBody: string): string {
  return createHmac('sha256', OPENPIX_SECRET).update(rawBody).digest('base64');
}

/** Sign a NOWPayments IPN body: HMAC-SHA512 hex over sorted-key JSON. */
function nowPaymentsSignature(body: unknown): string {
  return createHmac('sha512', IPN_SECRET).update(sortedJsonStringify(body)).digest('hex');
}

beforeAll(() => {
  // Any provider call this suite forgot to mock is a hard failure, never a
  // real request to a payment provider.
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
  nock.restore();
});

afterEach(() => {
  nock.cleanAll();
});

// ── §2 Provider factory ──────────────────────────────────────────────────────
describe('getPaymentProvider (factory)', () => {
  beforeEach(() => resetPaymentProviderCache());
  afterEach(() => {
    process.env.PAYMENT_PROVIDER_PIX = 'woovi';
    process.env.PAYMENT_PROVIDER_CRYPTO = 'nowpayments';
    process.env.PAYMENT_PROVIDER_CARD = 'mock';
    resetPaymentProviderCache();
  });

  it('resolves each channel to its configured adapter class', () => {
    expect(getPaymentProvider('pix')).toBeInstanceOf(WooviPixAdapter);
    expect(getPaymentProvider('crypto')).toBeInstanceOf(NOWPaymentsAdapter);
    expect(getPaymentProvider('card')).toBeInstanceOf(MockPaymentProvider);
  });

  it('records the channel each adapter serves', () => {
    expect(getPaymentProvider('pix').channel).toBe('pix');
    expect(getPaymentProvider('crypto').channel).toBe('crypto');
    expect(getPaymentProvider('card').channel).toBe('card');
    expect(getPaymentProvider('card').name).toBe('CCBILL_MOCK');
  });

  it('swaps the adapter class from the env var alone', () => {
    expect(getPaymentProvider('pix')).toBeInstanceOf(WooviPixAdapter);

    process.env.PAYMENT_PROVIDER_PIX = 'mock';
    resetPaymentProviderCache();

    const swapped = getPaymentProvider('pix');
    expect(swapped).toBeInstanceOf(MockPaymentProvider);
    // Still serving the pix channel — only the implementation changed.
    expect(swapped.channel).toBe('pix');
  });

  it('rejects any card adapter other than mock (CCBill is deferred)', () => {
    process.env.PAYMENT_PROVIDER_CARD = 'ccbill';
    resetPaymentProviderCache();
    expect(() => getPaymentProvider('card')).toThrow(PaymentProviderConfigError);
    expect(() => getPaymentProvider('card')).toThrow(/PAYMENT_PROVIDER_CARD/);
  });

  it('rejects an unknown adapter name on a live channel', () => {
    process.env.PAYMENT_PROVIDER_PIX = 'pagarme';
    resetPaymentProviderCache();
    expect(() => getPaymentProvider('pix')).toThrow(PaymentProviderConfigError);
  });
});

// ── §3 WooviPixAdapter ───────────────────────────────────────────────────────
describe('WooviPixAdapter', () => {
  const adapter = new WooviPixAdapter({
    appId: 'test-openpix-app-id',
    webhookSecret: OPENPIX_SECRET,
    apiUrl: WOOVI_URL,
  });

  it('creates a credit-pack charge and returns the QR + copia e cola payload', async () => {
    let sentBody: Record<string, unknown> = {};
    const scope = nock(WOOVI_URL)
      .post('/api/v1/charge', (body) => {
        sentBody = body as Record<string, unknown>;
        return true;
      })
      .matchHeader('authorization', 'test-openpix-app-id')
      .reply(200, wooviChargeReply('pack_abc'));

    const result = await adapter.createCharge({
      kind: 'credit_pack',
      correlationId: 'pack_abc',
      amountCents: 1990,
      currency: 'BRL',
      description: 'Starter credit pack',
      customer: { id: 'u_1', email: 'sub@example.com', name: 'Sub' },
    });

    expect(scope.isDone()).toBe(true);
    // The correlation id must reach the provider — that round trip is what
    // makes the webhook idempotent.
    expect(sentBody.correlationID).toBe('pack_abc');
    expect(sentBody.value).toBe(1990);
    expect(result.provider).toBe('WOOVI');
    expect(result.providerChargeId).toBe('woovi_tx_123');
    expect(result.payment).toMatchObject({
      method: 'pix',
      brCode: expect.stringContaining('BR.GOV.BCB.PIX'),
      qrCodeImage: expect.stringContaining('http'),
    });
  });

  it('registers the recurrence before charging the first subscription period', async () => {
    const subScope = nock(WOOVI_URL)
      .post('/api/v1/subscriptions')
      .reply(200, { subscription: { globalID: 'woovi_sub_1' } });
    const chargeScope = nock(WOOVI_URL)
      .post('/api/v1/charge')
      .reply(200, wooviChargeReply('sub_abc'));

    const result = await adapter.createCharge({
      kind: 'subscription',
      correlationId: 'sub_abc',
      amountCents: 2990,
      currency: 'BRL',
      description: 'Standard subscription',
      customer: { id: 'u_1', email: 'sub@example.com', name: 'Sub' },
      subscription: { modelId: 'u_2', tier: 'STANDARD', intervalDays: 30 },
    });

    expect(subScope.isDone()).toBe(true);
    expect(chargeScope.isDone()).toBe(true);
    expect(result.providerSubscriptionId).toBe('woovi_sub_1');
  });

  it('refuses a non-BRL charge without calling the provider', async () => {
    await expect(
      adapter.createCharge({
        kind: 'credit_pack',
        correlationId: 'pack_usd',
        amountCents: 399,
        currency: 'USD',
        description: 'Starter',
        customer: { id: 'u_1', email: 'sub@example.com', name: 'Sub' },
      }),
    ).rejects.toThrow(/BRL/);
  });

  it('accepts a correctly signed webhook and rejects a tampered one', () => {
    const raw = JSON.stringify({
      event: 'OPENPIX:CHARGE_COMPLETED',
      charge: { correlationID: 'pack_abc', transactionID: 'woovi_tx_123', status: 'COMPLETED' },
    });
    const headers = { 'x-webhook-signature': wooviSignature(raw) };

    expect(adapter.verifyWebhookSignature(Buffer.from(raw), headers)).toBe(true);
    // One byte of the body changed → the digest no longer matches.
    expect(
      adapter.verifyWebhookSignature(Buffer.from(raw.replace('pack_abc', 'pack_xyz')), headers),
    ).toBe(false);
    // …and a missing header is a rejection, not an exception.
    expect(adapter.verifyWebhookSignature(Buffer.from(raw), {})).toBe(false);
  });

  it('normalizes charge events to CONFIRMED / FAILED / PENDING', () => {
    const parse = (body: unknown) => adapter.parseWebhookEvent(Buffer.from(JSON.stringify(body)));

    expect(
      parse({
        event: 'OPENPIX:CHARGE_COMPLETED',
        charge: { correlationID: 'c1', transactionID: 't1', status: 'COMPLETED' },
      }).status,
    ).toBe('CONFIRMED');
    expect(
      parse({
        event: 'OPENPIX:CHARGE_EXPIRED',
        charge: { correlationID: 'c1', status: 'EXPIRED' },
      }).status,
    ).toBe('FAILED');
    expect(
      parse({
        event: 'OPENPIX:CHARGE_CREATED',
        charge: { correlationID: 'c1', status: 'ACTIVE' },
      }).status,
    ).toBe('PENDING');
  });
});

// ── §4 NOWPaymentsAdapter ────────────────────────────────────────────────────
describe('NOWPaymentsAdapter', () => {
  const adapter = new NOWPaymentsAdapter({
    apiKey: 'test-nowpayments-api-key',
    ipnSecret: IPN_SECRET,
    apiUrl: NOWPAYMENTS_URL,
  });

  it('creates a payment and returns the address + amount', async () => {
    let sentBody: Record<string, unknown> = {};
    const scope = nock(NOWPAYMENTS_URL)
      .post('/v1/payment', (body) => {
        sentBody = body as Record<string, unknown>;
        return true;
      })
      .matchHeader('x-api-key', 'test-nowpayments-api-key')
      .reply(200, nowPaymentsReply('pack_xyz'));

    const result = await adapter.createCharge({
      kind: 'credit_pack',
      correlationId: 'pack_xyz',
      amountCents: 399,
      currency: 'USD',
      description: 'Starter credit pack',
      customer: { id: 'u_1', email: 'sub@example.com', name: 'Sub' },
    });

    expect(scope.isDone()).toBe(true);
    // Cents on our side, major units on the wire — and the order id carries
    // our idempotency key.
    expect(sentBody.price_amount).toBe(3.99);
    expect(sentBody.order_id).toBe('pack_xyz');
    expect(result.payment).toMatchObject({
      method: 'crypto',
      payAddress: 'TXyz1234567890abcdefghijklmnopqrs',
      payAmount: '3.99123456',
      payCurrency: 'usdttrc20',
    });
  });

  it('skips recurrence registration when no plan id is configured', async () => {
    const scope = nock(NOWPAYMENTS_URL).post('/v1/payment').reply(200, nowPaymentsReply('sub_1'));

    const result = await adapter.createCharge({
      kind: 'subscription',
      correlationId: 'sub_1',
      amountCents: 599,
      currency: 'USD',
      description: 'Standard subscription',
      customer: { id: 'u_1', email: 'sub@example.com', name: 'Sub' },
      subscription: { modelId: 'u_2', tier: 'STANDARD', intervalDays: 30 },
    });

    expect(scope.isDone()).toBe(true);
    expect(result.providerSubscriptionId).toBeNull();
  });

  it('registers the recurrence when the tier has a configured plan id', async () => {
    const planned = new NOWPaymentsAdapter({
      apiKey: 'test-nowpayments-api-key',
      ipnSecret: IPN_SECRET,
      apiUrl: NOWPAYMENTS_URL,
      planIds: { STANDARD: 'plan_std_1' },
    });
    nock(NOWPAYMENTS_URL).post('/v1/payment').reply(200, nowPaymentsReply('sub_2'));
    const subScope = nock(NOWPAYMENTS_URL)
      .post('/v1/subscriptions', { subscription_plan_id: 'plan_std_1', email: 'sub@example.com' })
      .reply(200, { result: [{ id: 4242 }] });

    const result = await planned.createCharge({
      kind: 'subscription',
      correlationId: 'sub_2',
      amountCents: 599,
      currency: 'USD',
      description: 'Standard subscription',
      customer: { id: 'u_1', email: 'sub@example.com', name: 'Sub' },
      subscription: { modelId: 'u_2', tier: 'STANDARD', intervalDays: 30 },
    });

    expect(subScope.isDone()).toBe(true);
    expect(result.providerSubscriptionId).toBe('4242');
  });

  it('turns a provider 500 into a PaymentProviderError', async () => {
    nock(NOWPAYMENTS_URL).post('/v1/payment').reply(500, 'upstream exploded');
    await expect(
      adapter.createCharge({
        kind: 'credit_pack',
        correlationId: 'pack_boom',
        amountCents: 399,
        currency: 'USD',
        description: 'Starter',
        customer: { id: 'u_1', email: 'sub@example.com', name: 'Sub' },
      }),
    ).rejects.toThrow(/NOWPAYMENTS responded 500/);
  });

  it('verifies the IPN signature over sorted-key JSON', () => {
    const body = { payment_id: 1, order_id: 'pack_xyz', payment_status: 'finished' };
    const raw = Buffer.from(JSON.stringify(body));

    expect(
      adapter.verifyWebhookSignature(raw, { 'x-nowpayments-sig': nowPaymentsSignature(body) }),
    ).toBe(true);
    expect(adapter.verifyWebhookSignature(raw, { 'x-nowpayments-sig': 'deadbeef' })).toBe(false);
    expect(adapter.verifyWebhookSignature(raw, {})).toBe(false);
  });

  it('accepts a signature computed on differently ordered keys', () => {
    // The provider serializes in its own key order; only the sorted form is
    // signed, so our verification must not depend on wire order.
    const body = { order_id: 'pack_xyz', payment_status: 'finished', payment_id: 1 };
    const signature = nowPaymentsSignature({
      payment_id: 1,
      payment_status: 'finished',
      order_id: 'pack_xyz',
    });
    expect(
      adapter.verifyWebhookSignature(Buffer.from(JSON.stringify(body)), {
        'x-nowpayments-sig': signature,
      }),
    ).toBe(true);
  });
});

// ── §5 MockPaymentProvider ───────────────────────────────────────────────────
describe('MockPaymentProvider', () => {
  it('produces a deterministic charge with no HTTP at all', async () => {
    const mock = new MockPaymentProvider();
    const charge = await mock.createCharge({
      kind: 'subscription',
      correlationId: 'sub_mock_1',
      amountCents: 2990,
      currency: 'BRL',
      description: 'Standard subscription',
      customer: { id: 'u_1', email: 'sub@example.com', name: 'Sub' },
      subscription: { modelId: 'u_2', tier: 'STANDARD', intervalDays: 30 },
    });

    expect(charge.provider).toBe('CCBILL_MOCK');
    expect(charge.providerChargeId).toBe('mock_sub_mock_1');
    expect(charge.payment).toEqual({
      method: 'mock',
      checkoutUrl: 'https://mock-card.local/checkout/sub_mock_1',
    });
    // Same input, same output — nothing to pin down with a stub clock or RNG.
    expect(mock.getCharge('sub_mock_1')).toEqual(charge);
  });
});

// ── §1 Idempotency key uniqueness (DB-level) ─────────────────────────────────
describe('PaymentTransaction.idempotencyKey', () => {
  it('rejects a second row with the same key', async () => {
    const prisma = createFakePrisma();
    const base = {
      userId: 'u_1',
      type: 'CREDIT_PACK' as const,
      provider: 'WOOVI' as const,
      idempotencyKey: 'pack_dupe',
      amount: 1990,
      currency: 'BRL',
      creditsGranted: 100,
    };
    await prisma.paymentTransaction.create({ data: base });
    await expect(prisma.paymentTransaction.create({ data: base })).rejects.toBeInstanceOf(
      FakeUniqueConstraintError,
    );
    expect(prisma.__transactions).toHaveLength(1);
  });
});

// ── §6 Checkout endpoints ────────────────────────────────────────────────────
describe('POST /api/payments/checkout/subscription', () => {
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
    subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
  });

  const checkout = (payload: Record<string, unknown>, cookie: string | null = subCookie) =>
    app.inject({
      method: 'POST',
      url: '/api/payments/checkout/subscription',
      cookies: cookie ? { access_token: cookie } : undefined,
      payload,
    });

  it('creates a PENDING transaction and returns the PIX charge payload', async () => {
    let sentBody: Record<string, unknown> = {};
    nock(WOOVI_URL)
      .post('/api/v1/subscriptions')
      .reply(200, { subscription: { globalID: 's1' } });
    nock(WOOVI_URL)
      .post('/api/v1/charge', (body) => {
        sentBody = body as Record<string, unknown>;
        return true;
      })
      .reply(200, wooviChargeReply('unused'));

    const res = await checkout({ modelId, tier: 'STANDARD', provider: 'pix' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('PENDING');
    expect(body.provider).toBe('WOOVI');
    // Price comes from the catalog, not the client.
    expect(body.amount).toBe(2990);
    expect(body.currency).toBe('BRL');
    expect(body.payment.method).toBe('pix');
    expect(body.payment.brCode).toContain('BR.GOV.BCB.PIX');
    expect(body.payment.qrCodeImage).toBeTruthy();

    // Adapter received the catalog amount and our idempotency key.
    expect(sentBody.value).toBe(2990);
    expect(sentBody.correlationID).toBe(body.idempotencyKey);

    expect(prisma.__transactions).toHaveLength(1);
    const tx = prisma.__transactions[0];
    expect(tx).toMatchObject({
      status: 'PENDING',
      type: 'SUBSCRIPTION',
      provider: 'WOOVI',
      amount: 2990,
      modelId,
      tier: 'STANDARD',
    });
    expect(tx.idempotencyKey).toBe(body.idempotencyKey);

    // Every state-changing financial operation is audited.
    expect(prisma.__auditLogs.some((l) => l.action === 'payment.charge_created')).toBe(true);
  });

  it('ignores a client-supplied amount — the catalog price wins', async () => {
    nock(WOOVI_URL)
      .post('/api/v1/subscriptions')
      .reply(200, { subscription: { globalID: 's1' } });
    nock(WOOVI_URL).post('/api/v1/charge').reply(200, wooviChargeReply('unused'));

    const res = await checkout({ modelId, tier: 'PREMIUM', provider: 'pix', amount: 1 });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe(5990);
  });

  it('rejects an unauthenticated request → 401, no transaction', async () => {
    const res = await checkout({ modelId, tier: 'STANDARD', provider: 'pix' }, null);
    expect(res.statusCode).toBe(401);
    expect(prisma.__transactions).toHaveLength(0);
  });

  it('rejects a model (subscriber-only endpoint) → 403', async () => {
    const modelCookie = await loginAs(app, prisma, 'model', 'model2@example.com');
    const res = await checkout({ modelId, tier: 'STANDARD', provider: 'pix' }, modelCookie);
    expect(res.statusCode).toBe(403);
    expect(prisma.__transactions).toHaveLength(0);
  });

  it('rejects an unknown tier → 400', async () => {
    const res = await checkout({ modelId, tier: 'GOLD', provider: 'pix' });
    expect(res.statusCode).toBe(400);
    expect(prisma.__transactions).toHaveLength(0);
  });

  it('rejects an unknown model → 404', async () => {
    const res = await checkout({ modelId: 'u_missing', tier: 'STANDARD', provider: 'pix' });
    expect(res.statusCode).toBe(404);
  });

  it('marks the transaction FAILED and answers 502 when the provider errors', async () => {
    nock(WOOVI_URL).post('/api/v1/subscriptions').reply(503, 'unavailable');

    const res = await checkout({ modelId, tier: 'STANDARD', provider: 'pix' });

    expect(res.statusCode).toBe(502);
    expect(prisma.__transactions[0].status).toBe('FAILED');
    expect(prisma.__auditLogs.some((l) => l.action === 'payment.charge_failed')).toBe(true);
  });

  it('rate limits charge-spam at 10 requests per minute', async () => {
    nock(WOOVI_URL)
      .post('/api/v1/subscriptions')
      .times(12)
      .reply(200, { subscription: { globalID: 's1' } });
    nock(WOOVI_URL).post('/api/v1/charge').times(12).reply(200, wooviChargeReply('unused'));

    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await checkout({ modelId, tier: 'STANDARD', provider: 'pix' });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(10);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('POST /api/payments/checkout/credits', () => {
  let prisma: FakePrisma;
  let app: App;
  let subCookie: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
  });

  const checkout = (payload: Record<string, unknown>, cookie: string | null = subCookie) =>
    app.inject({
      method: 'POST',
      url: '/api/payments/checkout/credits',
      cookies: cookie ? { access_token: cookie } : undefined,
      payload,
    });

  it('returns the crypto payment address and amount', async () => {
    let sentBody: Record<string, unknown> = {};
    nock(NOWPAYMENTS_URL)
      .post('/v1/payment', (body) => {
        sentBody = body as Record<string, unknown>;
        return true;
      })
      .reply(200, nowPaymentsReply('unused'));

    const res = await checkout({ packId: 'starter', provider: 'crypto' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.provider).toBe('NOWPAYMENTS');
    expect(body.currency).toBe('USD');
    expect(body.amount).toBe(399);
    expect(body.payment).toMatchObject({
      method: 'crypto',
      payAddress: 'TXyz1234567890abcdefghijklmnopqrs',
      payAmount: '3.99123456',
    });
    expect(sentBody.order_id).toBe(body.idempotencyKey);

    const tx = prisma.__transactions[0];
    expect(tx).toMatchObject({
      status: 'PENDING',
      type: 'CREDIT_PACK',
      provider: 'NOWPAYMENTS',
      creditsGranted: 100,
    });
  });

  it('creates a PIX credit-pack charge in BRL', async () => {
    nock(WOOVI_URL).post('/api/v1/charge').reply(200, wooviChargeReply('unused'));
    const res = await checkout({ packId: 'plus', provider: 'pix' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ currency: 'BRL', amount: 4990 });
    expect(prisma.__transactions[0].creditsGranted).toBe(300);
  });

  it('rejects an unknown pack → 404', async () => {
    const res = await checkout({ packId: 'not-a-pack', provider: 'pix' });
    expect(res.statusCode).toBe(404);
    expect(prisma.__transactions).toHaveLength(0);
  });

  it('rejects the card channel at checkout → 400', async () => {
    const res = await checkout({ packId: 'starter', provider: 'card' });
    expect(res.statusCode).toBe(400);
  });
});

// ── §7 Webhooks ──────────────────────────────────────────────────────────────
describe('POST /api/payments/woovi/webhook', () => {
  let prisma: FakePrisma;
  let app: App;
  let subCookie: string;
  let subId: string;
  let modelId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
    seedProfile(prisma, modelId);
    subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    subId = userIdFor(prisma, 'sub@example.com');
  });

  /** Run a subscription checkout and return its idempotency key. */
  async function startSubscriptionCheckout(tier: 'STANDARD' | 'PREMIUM' = 'STANDARD') {
    nock(WOOVI_URL)
      .post('/api/v1/subscriptions')
      .reply(200, { subscription: { globalID: 's1' } });
    nock(WOOVI_URL).post('/api/v1/charge').reply(200, wooviChargeReply('unused'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/checkout/subscription',
      cookies: { access_token: subCookie },
      payload: { modelId, tier, provider: 'pix' },
    });
    return res.json().idempotencyKey as string;
  }

  function postWebhook(rawBody: string, signature = wooviSignature(rawBody)) {
    return app.inject({
      method: 'POST',
      url: '/api/payments/woovi/webhook',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
      payload: rawBody,
    });
  }

  const completedBody = (correlationId: string) =>
    JSON.stringify({
      event: 'OPENPIX:CHARGE_COMPLETED',
      charge: { correlationID: correlationId, transactionID: 'woovi_tx_777', status: 'COMPLETED' },
    });

  it('confirms a subscription, creates the Subscription row and grants ContentAccess', async () => {
    const standard = seedContent(prisma, { modelId, tier: 'STANDARD' });
    const premium = seedContent(prisma, { modelId, tier: 'PREMIUM' });
    const key = await startSubscriptionCheckout('STANDARD');

    const res = await postWebhook(completedBody(key));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, processed: true, duplicate: false });

    const tx = prisma.__transactions.find((t) => t.idempotencyKey === key)!;
    expect(tx.status).toBe('CONFIRMED');
    expect(tx.providerTransactionId).toBe('woovi_tx_777');
    expect(tx.confirmedAt).toBeInstanceOf(Date);

    expect(prisma.__subscriptions).toHaveLength(1);
    expect(prisma.__subscriptions[0]).toMatchObject({
      subscriberId: subId,
      modelId,
      tier: 'STANDARD',
      status: 'ACTIVE',
      provider: 'WOOVI',
    });
    expect(prisma.__subscriptions[0].currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

    // STANDARD unlocks STANDARD content only — PREMIUM stays locked.
    const granted = prisma.__accesses.filter((a) => a.userId === subId);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      contentId: standard.id,
      grantReason: 'subscription_standard',
    });
    expect(granted.some((a) => a.contentId === premium.id)).toBe(false);
    // Access expires with the billing period, so a lapse needs no revoke job.
    expect(granted[0].expiresAt).toEqual(prisma.__subscriptions[0].currentPeriodEnd);

    expect(prisma.__auditLogs.some((l) => l.action === 'payment.confirmed')).toBe(true);
    expect(prisma.__auditLogs.some((l) => l.action === 'subscription.activated')).toBe(true);
  });

  it('grants both tiers for a PREMIUM subscription', async () => {
    seedContent(prisma, { modelId, tier: 'STANDARD' });
    seedContent(prisma, { modelId, tier: 'PREMIUM' });
    const key = await startSubscriptionCheckout('PREMIUM');

    await postWebhook(completedBody(key));

    const granted = prisma.__accesses.filter((a) => a.userId === subId);
    expect(granted).toHaveLength(2);
    expect(granted.every((a) => a.grantReason === 'subscription_premium')).toBe(true);
  });

  it('applies an identical redelivery exactly once', async () => {
    seedContent(prisma, { modelId, tier: 'STANDARD' });
    const key = await startSubscriptionCheckout('STANDARD');
    const body = completedBody(key);

    const first = await postWebhook(body);
    const second = await postWebhook(body);

    expect(first.json()).toMatchObject({ processed: true, duplicate: false });
    // Still 200: a retry cannot fix anything, so the provider must stop retrying.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ processed: false, duplicate: true });

    expect(prisma.__subscriptions).toHaveLength(1);
    expect(prisma.__accesses.filter((a) => a.userId === subId)).toHaveLength(1);
    expect(prisma.__auditLogs.filter((l) => l.action === 'payment.confirmed')).toHaveLength(1);
  });

  it('credits the wallet exactly once for a redelivered credit-pack webhook', async () => {
    nock(WOOVI_URL).post('/api/v1/charge').reply(200, wooviChargeReply('unused'));
    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/api/payments/checkout/credits',
      cookies: { access_token: subCookie },
      payload: { packId: 'starter', provider: 'pix' },
    });
    const key = checkoutRes.json().idempotencyKey as string;
    const body = completedBody(key);

    await postWebhook(body);
    expect(prisma.__wallets.find((w) => w.userId === subId)!.balance).toBe(100);

    await postWebhook(body);
    // The DB claim matched zero rows the second time, so no second credit.
    expect(prisma.__wallets.find((w) => w.userId === subId)!.balance).toBe(100);
    expect(prisma.__auditLogs.filter((l) => l.action === 'wallet.credited')).toHaveLength(1);
  });

  it('rejects a bad signature with 400 and writes nothing', async () => {
    seedContent(prisma, { modelId, tier: 'STANDARD' });
    const key = await startSubscriptionCheckout('STANDARD');
    const auditCountBefore = prisma.__auditLogs.length;

    const res = await postWebhook(completedBody(key), 'not-the-right-signature');

    expect(res.statusCode).toBe(400);
    expect(prisma.__transactions.find((t) => t.idempotencyKey === key)!.status).toBe('PENDING');
    expect(prisma.__subscriptions).toHaveLength(0);
    expect(prisma.__accesses).toHaveLength(0);
    expect(prisma.__auditLogs).toHaveLength(auditCountBefore);
  });

  it('rejects a missing signature header with 400', async () => {
    const key = await startSubscriptionCheckout('STANDARD');
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/woovi/webhook',
      headers: { 'content-type': 'application/json' },
      payload: completedBody(key),
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.__transactions.find((t) => t.idempotencyKey === key)!.status).toBe('PENDING');
  });

  it('leaves an unknown correlation id alone and answers 200', async () => {
    const res = await postWebhook(completedBody('sub_never_created'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ processed: false, duplicate: true });
    expect(prisma.__subscriptions).toHaveLength(0);
  });

  it('marks the transaction FAILED on an expiry event', async () => {
    const key = await startSubscriptionCheckout('STANDARD');
    const body = JSON.stringify({
      event: 'OPENPIX:CHARGE_EXPIRED',
      charge: { correlationID: key, transactionID: 'woovi_tx_exp', status: 'EXPIRED' },
    });

    const res = await postWebhook(body);

    expect(res.statusCode).toBe(200);
    expect(prisma.__transactions.find((t) => t.idempotencyKey === key)!.status).toBe('FAILED');
    expect(prisma.__subscriptions).toHaveLength(0);
    expect(prisma.__auditLogs.some((l) => l.action === 'payment.failed')).toBe(true);
  });

  it('leaves the transaction PENDING for a non-terminal event', async () => {
    const key = await startSubscriptionCheckout('STANDARD');
    const body = JSON.stringify({
      event: 'OPENPIX:CHARGE_CREATED',
      charge: { correlationID: key, transactionID: 'woovi_tx_new', status: 'ACTIVE' },
    });

    const res = await postWebhook(body);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ processed: false });
    expect(prisma.__transactions.find((t) => t.idempotencyKey === key)!.status).toBe('PENDING');
  });
});

describe('POST /api/payments/nowpayments/webhook', () => {
  let prisma: FakePrisma;
  let app: App;
  let subCookie: string;
  let subId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma);
    subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    subId = userIdFor(prisma, 'sub@example.com');
  });

  async function startCreditsCheckout(): Promise<string> {
    nock(NOWPAYMENTS_URL).post('/v1/payment').reply(200, nowPaymentsReply('unused'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/checkout/credits',
      cookies: { access_token: subCookie },
      payload: { packId: 'pro', provider: 'crypto' },
    });
    return res.json().idempotencyKey as string;
  }

  it('credits the wallet on a finished IPN', async () => {
    const key = await startCreditsCheckout();
    const body = { payment_id: 987654321, payment_status: 'finished', order_id: key };

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/nowpayments/webhook',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': nowPaymentsSignature(body),
      },
      payload: JSON.stringify(body),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.__wallets.find((w) => w.userId === subId)!.balance).toBe(1000);
    expect(prisma.__transactions[0].status).toBe('CONFIRMED');
    expect(prisma.__transactions[0].providerTransactionId).toBe('987654321');
    expect(prisma.__auditLogs.some((l) => l.action === 'payment.confirmed')).toBe(true);
  });

  it('rejects a forged IPN signature with 400 and no wallet change', async () => {
    await startCreditsCheckout();
    const body = { payment_id: 987654321, payment_status: 'finished', order_id: 'whatever' };

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/nowpayments/webhook',
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': 'ff'.repeat(64) },
      payload: JSON.stringify(body),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.__wallets).toHaveLength(0);
    expect(prisma.__transactions[0].status).toBe('PENDING');
  });
});
