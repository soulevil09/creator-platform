// =============================================================================
// Provider `disabled` mode + production mock ban (Session 13, D1).
//
//   §1  boot matrix: every channel × {unset, disabled, active without creds,
//       active with creds, mock in prod, mock in dev, unknown}
//   §2  factories: `isEnabled`, and a disabled channel never yields an adapter
//   §3  checkout on a disabled channel → 503 before any database call
//   §4  webhooks of disabled channels → 404 (route not registered)
//   §5  GET /api/payments/channels lists enabled names only
//   §6  payout run: 401 without the secret, 503 with it, nothing written
//   §7  generation: 503 before any credit debit
//   §8  email: register fails closed; the renewal reminder is skipped
//   §9  renewal sweep with a disabled channel: no charge, counted, idempotent
//
// Same harness as every other suite (fake Prisma, `inject`, nock with
// `disableNetConnect`). "Zero database calls" is measured by a recording proxy
// around the fake client, so it counts every delegate — reads included.
// =============================================================================
import nock from 'nock';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer, type BuildServerOptions } from '../index.js';
import { loadEnv, type EnvSource } from '../lib/env.js';
import {
  EmailDisabledError,
  createDisabledEmailer,
  renderRenewalReminderEmail,
  type Emailer,
} from '../lib/email.js';
import type { ImageProcessor } from '../lib/image.js';
import type { PrismaClient } from '../lib/prisma.js';
import type { StorageClient } from '../lib/storage.js';
import { PROVIDER_CHANNELS, type ProviderChannel } from '../lib/provider-mode.js';
import {
  getPaymentProvider,
  isEnabled as isPaymentChannelEnabled,
  resetPaymentProviderCache,
} from '../modules/payments/provider.factory.js';
import { PaymentProviderConfigError } from '../modules/payments/provider.interface.js';
import {
  getPayoutProvider,
  isEnabled as isPayoutEnabled,
  resetPayoutProviderCache,
} from '../modules/payouts/provider.factory.js';
import { PayoutProviderConfigError } from '../modules/payouts/provider.interface.js';
import {
  getAIProvider,
  isEnabled as isAIEnabled,
  resetAIProviderCache,
} from '../modules/generation/provider.factory.js';
import { AIProviderConfigError } from '../modules/generation/provider.interface.js';
import {
  createFakeEmailer,
  createFakePrisma,
  seedProfile,
  seedReferenceImage,
  seedSubscription,
  seedWallet,
  type FakePrisma,
} from '../test/fake-prisma.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WOOVI_URL = 'https://woovi.test';

// ── §1 Boot matrix ───────────────────────────────────────────────────────────

/** What "active" means per channel, and which credentials it needs. */
const ACTIVE: Record<ProviderChannel, { name: string; creds: string[] }> = {
  pix: { name: 'woovi', creds: ['OPENPIX_APP_ID', 'OPENPIX_WEBHOOK_SECRET'] },
  crypto: { name: 'nowpayments', creds: ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET'] },
  card: { name: 'mock', creds: [] },
  payout: { name: 'paxum', creds: ['PAXUM_API_KEY', 'PAXUM_IPN_SECRET'] },
  ai: { name: 'replicate', creds: ['AI_PROVIDER_API_KEY'] },
  email: { name: 'resend', creds: ['EMAIL_API_KEY'] },
};

/** Every channel disabled, nothing optional set: the minimal bootable config. */
function baseSource(nodeEnv: 'development' | 'production'): EnvSource {
  const source: EnvSource = {
    NODE_ENV: nodeEnv,
    JWT_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    STORAGE_ENDPOINT: 'http://storage.test',
    STORAGE_BUCKET: 'bucket',
    STORAGE_ACCESS_KEY: 'ak',
    STORAGE_SECRET_KEY: 'sk',
    WATERMARK_TRACE_SECRET: 'w'.repeat(32),
  };
  for (const spec of Object.values(PROVIDER_CHANNELS)) source[spec.envVar] = 'disabled';
  if (nodeEnv === 'production') {
    Object.assign(source, {
      APP_URL: 'https://app.visorfans.com',
      API_PUBLIC_URL: 'https://api.visorfans.com',
      TRUST_PROXY: '172.30.0.0/24',
      PAYOUT_CRON_SECRET: 'x',
      SUBSCRIPTION_RENEWAL_CRON_SECRET: 'x',
      STORAGE_CLEANUP_CRON_SECRET: 'x',
      RECONCILIATION_CRON_SECRET: 'x',
    });
  }
  return source;
}

const withCreds = (channel: ProviderChannel): EnvSource =>
  Object.fromEntries(ACTIVE[channel].creds.map((name) => [name, `test-${name}`]));

describe('§1 boot matrix', () => {
  const channels = Object.keys(PROVIDER_CHANNELS) as ProviderChannel[];

  describe.each(channels)('%s', (channel) => {
    const envVar = PROVIDER_CHANNELS[channel].envVar;
    const active = ACTIVE[channel];
    const prodAllowsActive = PROVIDER_CHANNELS[channel].productionAllowed.includes(active.name);

    it('unset → boots, disabled', () => {
      const source = baseSource('development');
      delete source[envVar];
      expect(loadEnv(source).PROVIDERS[channel]).toBe('disabled');
    });

    it('unset in production → boots, disabled', () => {
      const source = baseSource('production');
      delete source[envVar];
      expect(loadEnv(source).PROVIDERS[channel]).toBe('disabled');
    });

    it('disabled → boots and needs no credentials', () => {
      expect(loadEnv(baseSource('development')).PROVIDERS[channel]).toBe('disabled');
    });

    it.runIf(active.creds.length > 0)(
      'active without credentials → crashes naming the variable',
      () => {
        expect(() => loadEnv({ ...baseSource('development'), [envVar]: active.name })).toThrow(
          new RegExp(`${active.creds[0]}.*${envVar}=${active.name}`),
        );
      },
    );

    it('active with credentials → boots with that adapter', () => {
      const env = loadEnv({
        ...baseSource('development'),
        [envVar]: active.name,
        ...withCreds(channel),
      });
      expect(env.PROVIDERS[channel]).toBe(active.name);
    });

    it.runIf(prodAllowsActive)('active with credentials in production → boots', () => {
      const env = loadEnv({
        ...baseSource('production'),
        [envVar]: active.name,
        ...withCreds(channel),
      });
      expect(env.PROVIDERS[channel]).toBe(active.name);
    });

    it('mock in production → crashes naming the variable', () => {
      expect(() => loadEnv({ ...baseSource('production'), [envVar]: 'mock' })).toThrow(
        new RegExp(`${envVar}=mock is not allowed in production`),
      );
    });

    it('mock in development → boots', () => {
      expect(loadEnv({ ...baseSource('development'), [envVar]: 'mock' }).PROVIDERS[channel]).toBe(
        'mock',
      );
    });

    it('unknown value → crashes in every environment', () => {
      for (const nodeEnv of ['development', 'production'] as const) {
        expect(() => loadEnv({ ...baseSource(nodeEnv), [envVar]: 'stripe' })).toThrow(
          new RegExp(`${envVar}="stripe" is not a known value`),
        );
      }
    });
  });

  it('EMAIL_PROVIDER=resend is refused in production (Resend AUP), even with a key', () => {
    expect(() =>
      loadEnv({ ...baseSource('production'), EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_x' }),
    ).toThrow(/EMAIL_PROVIDER=resend is not allowed in production/);
  });

  it('the card channel accepts only mock (non-production) or disabled until CCBill', () => {
    expect(() =>
      loadEnv({ ...baseSource('development'), PAYMENT_PROVIDER_CARD: 'ccbill' }),
    ).toThrow(/PAYMENT_PROVIDER_CARD="ccbill" is not a known value/);
    expect(PROVIDER_CHANNELS.card.productionAllowed).toEqual(['disabled']);
  });

  it('PAYOUT_CRON_SECRET is required in production only while payouts are enabled', () => {
    const disabled = { ...baseSource('production'), PAYOUT_CRON_SECRET: undefined };
    expect(() => loadEnv(disabled)).not.toThrow();
    expect(() =>
      loadEnv({ ...disabled, PAYOUT_PROVIDER: 'paxum', ...withCreds('payout') }),
    ).toThrow(/PAYOUT_CRON_SECRET/);
  });
});

// ── §2 Factories ─────────────────────────────────────────────────────────────
describe('§2 factories', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPaymentProviderCache();
    resetPayoutProviderCache();
    resetAIProviderCache();
  });

  it('isEnabled follows the env var; unset means disabled', () => {
    vi.stubEnv('PAYMENT_PROVIDER_CARD', '');
    vi.stubEnv('PAYOUT_PROVIDER', 'disabled');
    vi.stubEnv('AI_PROVIDER', 'disabled');
    expect(isPaymentChannelEnabled('card')).toBe(false);
    expect(isPayoutEnabled()).toBe(false);
    expect(isAIEnabled()).toBe(false);
    vi.stubEnv('PAYMENT_PROVIDER_CARD', 'mock');
    expect(isPaymentChannelEnabled('card')).toBe(true);
  });

  it.each([
    ['ai', 'AI_PROVIDER'],
    ['payout', 'PAYOUT_PROVIDER'],
  ] as const)(
    'unset %s (%s) defaults to disabled — at boot and in the factory, no real adapter',
    (channel, envVar) => {
      const source = baseSource('development');
      delete source[envVar];
      delete source.AI_PROVIDER_API_KEY;
      delete source.PAXUM_API_KEY;
      // Boots with no credentials at all: nothing defaulted to replicate/paxum.
      expect(loadEnv(source).PROVIDERS[channel]).toBe('disabled');

      const saved = process.env[envVar];
      delete process.env[envVar];
      try {
        expect(channel === 'ai' ? isAIEnabled() : isPayoutEnabled()).toBe(false);
        expect(() => (channel === 'ai' ? getAIProvider() : getPayoutProvider())).toThrow(
          /disabled/,
        );
      } finally {
        process.env[envVar] = saved;
      }
    },
  );

  it('a disabled channel never yields an adapter (and never falls back to mock)', () => {
    vi.stubEnv('PAYMENT_PROVIDER_PIX', 'disabled');
    vi.stubEnv('PAYOUT_PROVIDER', 'disabled');
    vi.stubEnv('AI_PROVIDER', 'disabled');
    expect(() => getPaymentProvider('pix')).toThrow(PaymentProviderConfigError);
    expect(() => getPayoutProvider()).toThrow(PayoutProviderConfigError);
    expect(() => getAIProvider()).toThrow(AIProviderConfigError);
  });

  it('the disabled emailer throws a typed error if a call site forgets to check', async () => {
    const emailer = createDisabledEmailer();
    await expect(emailer.sendVerificationEmail('a@b.c', 't', 'en')).rejects.toThrow(
      EmailDisabledError,
    );
  });
});

// ── HTTP harness ─────────────────────────────────────────────────────────────

/** Records every delegate method call (reads included) on the fake client. */
function recordCalls(prisma: FakePrisma) {
  const calls: string[] = [];
  const proxy = new Proxy(prisma, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || prop.startsWith('__')) return value;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          calls.push(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (value && typeof value === 'object') {
        return new Proxy(value as object, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method);
            if (typeof fn !== 'function') return fn;
            return (...args: unknown[]) => {
              calls.push(`${prop}.${String(method)}`);
              return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      }
      return value;
    },
  });
  return { prisma: proxy, calls };
}

const fakeStorage = (): StorageClient => ({
  uploadFile: vi.fn(async (_b: string, key: string) => key),
  getSignedUrl: vi.fn(async () => 'https://signed.example/x'),
  getObject: vi.fn(async () => Buffer.from('RAW')),
  deleteFile: vi.fn(async () => {}),
});
const fakeImages = (): ImageProcessor => ({
  getDimensions: vi.fn(async () => ({ width: 1, height: 1 })),
  watermark: vi.fn(async (b: Buffer) => b),
});

async function makeHarness(opts: Partial<BuildServerOptions> = {}) {
  const fake = createFakePrisma();
  const { prisma, calls } = recordCalls(fake);
  const app = await buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage: fakeStorage(),
    images: fakeImages(),
    ...opts,
  });
  return { app, fake, calls };
}
type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** A verified user straight into the fake, then a real login → access cookie. */
async function loginSeeded(h: Harness, role: 'SUBSCRIBER' | 'MODEL' | 'ADMIN', email: string) {
  const now = new Date();
  const id = `u_${role.toLowerCase()}_${h.fake.__users.length + 1}`;
  h.fake.__users.push({
    id,
    email,
    passwordHash: bcrypt.hashSync('supersecret', 4),
    role,
    displayName: email,
    isVerified: true,
    verifyToken: null,
    verifyTokenExpiresAt: null,
    refreshTokenHash: null,
    preferredLocale: 'en',
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'supersecret' },
  });
  expect(res.statusCode).toBe(200);
  return { id, cookie: res.cookies.find((c) => c.name === 'access_token')!.value };
}

beforeAll(() => nock.disableNetConnect());
afterAll(() => {
  nock.enableNetConnect();
  nock.restore();
});
afterEach(() => nock.cleanAll());

// ── §3 Checkout ──────────────────────────────────────────────────────────────
describe('§3 checkout on a disabled channel', () => {
  let h: Harness;
  let subscriber: { id: string; cookie: string };
  let modelId: string;

  beforeEach(async () => {
    h = await makeHarness({ enabled: { pix: false, crypto: false } });
    subscriber = await loginSeeded(h, 'SUBSCRIBER', 'sub@example.com');
    modelId = (await loginSeeded(h, 'MODEL', 'model@example.com')).id;
    seedProfile(h.fake, modelId);
    h.calls.length = 0;
  });

  it.each(['pix', 'crypto'] as const)(
    'credit pack via %s → 503 payment_channel_unavailable, zero database calls',
    async (provider) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/payments/checkout/credits',
        cookies: { access_token: subscriber.cookie },
        payload: { packId: 'starter', provider },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'payment_channel_unavailable' });
      expect(h.calls).toEqual([]);
      expect(h.fake.__transactions).toHaveLength(0);
    },
  );

  it.each(['pix', 'crypto'] as const)(
    'subscription via %s → 503 payment_channel_unavailable, zero database calls',
    async (provider) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/payments/checkout/subscription',
        cookies: { access_token: subscriber.cookie },
        payload: { modelId, tier: 'STANDARD', provider },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'payment_channel_unavailable' });
      expect(h.calls).toEqual([]);
      expect(h.fake.__transactions).toHaveLength(0);
    },
  );

  it('an enabled channel still checks out (control)', async () => {
    const h2 = await makeHarness({ enabled: { pix: false, crypto: true } });
    const sub = await loginSeeded(h2, 'SUBSCRIBER', 'sub2@example.com');
    nock('https://nowpayments.test').post('/v1/payment').reply(201, {
      payment_id: 1,
      payment_status: 'waiting',
      pay_address: 'TXyz',
      pay_amount: '3.99',
      pay_currency: 'usdttrc20',
      order_id: 'x',
    });
    const res = await h2.app.inject({
      method: 'POST',
      url: '/api/payments/checkout/credits',
      cookies: { access_token: sub.cookie },
      payload: { packId: 'starter', provider: 'crypto' },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ── §4 Webhooks ──────────────────────────────────────────────────────────────
describe('§4 webhooks of disabled channels are not routes', () => {
  const allDisabled = { pix: false, crypto: false, card: false, payout: false, ai: false };

  it.each([
    '/api/payments/woovi/webhook',
    '/api/payments/nowpayments/webhook',
    '/api/payouts/paxum/webhook',
  ])('POST %s → 404, the same answer as an unknown path', async (url) => {
    const h = await makeHarness({ enabled: allDisabled });
    const res = await h.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: '{"event":"x"}',
    });
    const unknown = await h.app.inject({
      method: 'POST',
      url: '/api/payments/nope/webhook',
      headers: { 'content-type': 'application/json' },
      payload: '{"event":"x"}',
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(unknown.body.replace('/api/payments/nope/webhook', url));
    expect(h.calls).toEqual([]);
  });

  it('enabled, the same webhook is routed and still verifies its signature (400)', async () => {
    const h = await makeHarness({ enabled: { pix: true } });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/payments/woovi/webhook',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': 'forged' },
      payload: '{"event":"x"}',
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── §5 Channel list ──────────────────────────────────────────────────────────
describe('§5 GET /api/payments/channels', () => {
  it('requires a session', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({ method: 'GET', url: '/api/payments/channels' });
    expect(res.statusCode).toBe(401);
  });

  it('lists enabled checkout channels only — names, nothing else', async () => {
    const h = await makeHarness({ enabled: { pix: false, crypto: true } });
    const { cookie } = await loginSeeded(h, 'SUBSCRIBER', 's@example.com');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/payments/channels',
      cookies: { access_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ channels: ['crypto'] });
    expect(res.body).not.toMatch(/nowpayments|woovi/i);
  });

  it('all disabled → an empty list', async () => {
    const h = await makeHarness({ enabled: { pix: false, crypto: false } });
    const { cookie } = await loginSeeded(h, 'MODEL', 'm@example.com');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/payments/channels',
      cookies: { access_token: cookie },
    });
    expect(res.json()).toEqual({ channels: [] });
  });
});

// ── §6 Payout run ────────────────────────────────────────────────────────────
describe('§6 payout run with payouts disabled', () => {
  const run = (h: Harness, secret?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/payouts/run',
      headers: secret ? { 'x-payout-cron-secret': secret } : {},
    });

  it('no secret → 401 (the secret check still wins)', async () => {
    const h = await makeHarness({ enabled: { payout: false } });
    expect((await run(h)).statusCode).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('valid secret → 503 payouts_disabled, zero database calls', async () => {
    const h = await makeHarness({ enabled: { payout: false } });
    const res = await run(h, 'test-payout-cron-secret');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'payouts_disabled' });
    expect(h.calls).toEqual([]);
  });

  it('the admin entrance answers the same 503', async () => {
    const h = await makeHarness({ enabled: { payout: false } });
    const admin = await loginSeeded(h, 'ADMIN', 'admin@example.com');
    h.calls.length = 0;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/admin/payouts/run',
      cookies: { access_token: admin.cookie },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'payouts_disabled' });
    expect(h.calls).toEqual([]);
  });
});

// ── §7 Generation ────────────────────────────────────────────────────────────
describe('§7 generation with AI disabled', () => {
  it('create → 503 generation_unavailable before any read or debit', async () => {
    const h = await makeHarness({ enabled: { ai: false } });
    const sub = await loginSeeded(h, 'SUBSCRIBER', 'sub@example.com');
    const model = await loginSeeded(h, 'MODEL', 'model@example.com');
    seedProfile(h.fake, model.id, undefined, { aiConsent: true });
    seedReferenceImage(h.fake, model.id);
    seedWallet(h.fake, sub.id, 100);
    h.calls.length = 0;

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/generations',
      cookies: { access_token: sub.cookie },
      payload: { modelId: model.id, mode: 'preset', presetId: 'scene_beach_sunset' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'generation_unavailable' });
    expect(h.calls).toEqual([]);
    expect(h.fake.__wallets.find((w) => w.userId === sub.id)!.balance).toBe(100);
    expect(h.fake.__generationJobs).toHaveLength(0);
  });

  it('reads of existing jobs keep working', async () => {
    const h = await makeHarness({ enabled: { ai: false } });
    const sub = await loginSeeded(h, 'SUBSCRIBER', 'sub@example.com');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/generations',
      cookies: { access_token: sub.cookie },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── §8 Email ─────────────────────────────────────────────────────────────────
describe('§8 email disabled', () => {
  it('register → 503 registration_unavailable, no User row, zero database calls', async () => {
    const h = await makeHarness({ enabled: { email: false }, emailer: createDisabledEmailer() });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'new@example.com',
        password: 'supersecret',
        displayName: 'New',
        role: 'subscriber',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'registration_unavailable' });
    expect(h.fake.__users).toHaveLength(0);
    expect(h.calls).toEqual([]);
  });

  it('an already-registered address gets the same 503 (no existence oracle)', async () => {
    const h = await makeHarness({ enabled: { email: false }, emailer: createDisabledEmailer() });
    await loginSeeded(h, 'SUBSCRIBER', 'taken@example.com');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'taken@example.com',
        password: 'supersecret',
        displayName: 'X',
        role: 'subscriber',
      },
    });
    expect(res.statusCode).toBe(503);
  });

  it('existing verified users still log in', async () => {
    const h = await makeHarness({ enabled: { email: false }, emailer: createDisabledEmailer() });
    await loginSeeded(h, 'SUBSCRIBER', 'old@example.com'); // asserts 200 inside
  });
});

// ── §8/§9 Renewal sweep ──────────────────────────────────────────────────────
describe('§9 renewal sweep', () => {
  const runSweep = (h: Harness) =>
    h.app.inject({
      method: 'POST',
      url: '/api/subscriptions/renewals/run',
      headers: { 'x-renewal-cron-secret': 'test-renewal-cron-secret' },
    });

  /** A due ACTIVE subscription whose last confirmed payment was BRL (→ pix). */
  async function dueSubscription(h: Harness) {
    const sub = await loginSeeded(h, 'SUBSCRIBER', 'sub@example.com');
    const model = await loginSeeded(h, 'MODEL', 'model@example.com');
    seedProfile(h.fake, model.id);
    const createdAt = new Date(Date.now() - 27 * DAY_MS);
    h.fake.__transactions.push({
      id: 'tx_hist_1',
      userId: sub.id,
      type: 'SUBSCRIPTION',
      provider: 'WOOVI',
      providerTransactionId: 'woovi_tx_hist',
      idempotencyKey: 'sub_hist_1',
      amount: 2990,
      currency: 'BRL',
      creditsGranted: null,
      modelId: model.id,
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
    return seedSubscription(h.fake, {
      subscriberId: sub.id,
      modelId: model.id,
      currentPeriodEnd: new Date(Date.now() + 2 * DAY_MS),
    });
  }

  it('a disabled channel issues no charge, is counted, and a rerun changes nothing', async () => {
    const h = await makeHarness({ enabled: { pix: false } });
    const subscription = await dueSubscription(h);

    // No nock interceptor is armed: a provider call would be a hard failure.
    const first = await runSweep(h);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ remindersIssued: 0, skippedChannelDisabled: 1 });
    expect(h.fake.__transactions).toHaveLength(1); // only the seeded history row

    const auditsAfterFirst = h.fake.__auditLogs.filter(
      (a) => a.action !== 'subscription.renewal_run_completed',
    ).length;
    const second = await runSweep(h);
    expect(second.json()).toMatchObject({ remindersIssued: 0, skippedChannelDisabled: 1 });
    expect(h.fake.__transactions).toHaveLength(1);
    expect(
      h.fake.__auditLogs.filter((a) => a.action !== 'subscription.renewal_run_completed').length,
    ).toBe(auditsAfterFirst);
    expect(h.fake.__subscriptions.find((s) => s.id === subscription.id)!.status).toBe('ACTIVE');
  });

  it('the lifecycle is unchanged: a lapsed subscription on a disabled rail still goes PAST_DUE', async () => {
    const h = await makeHarness({ enabled: { pix: false } });
    const subscription = await dueSubscription(h);
    subscription.currentPeriodEnd = new Date(Date.now() - DAY_MS);
    const res = await runSweep(h);
    expect(res.json()).toMatchObject({ movedToPastDue: 1 });
  });

  it('email disabled: the charge is issued, the reminder skipped, counted and not sent', async () => {
    const sent: unknown[] = [];
    const emailer: Emailer = {
      sendVerificationEmail: vi.fn(async () => {}),
      sendRenewalReminderEmail: vi.fn(async (_to, params, locale) => {
        sent.push(renderRenewalReminderEmail(params, locale));
      }),
    };
    const h = await makeHarness({ enabled: { pix: true, email: false }, emailer });
    await dueSubscription(h);
    nock(WOOVI_URL)
      .post('/api/v1/subscriptions')
      .reply(200, { subscription: { globalID: 's1' } });
    nock(WOOVI_URL)
      .post('/api/v1/charge')
      .reply(200, {
        charge: {
          correlationID: 'x',
          transactionID: 'woovi_tx_1',
          status: 'ACTIVE',
          brCode: '000201',
          qrCodeImage: 'https://api.woovi.com/qr.png',
        },
      });

    const res = await runSweep(h);
    expect(res.json()).toMatchObject({ remindersIssued: 1, remindersSkipped: 1 });
    expect(sent).toEqual([]);
    expect(
      h.fake.__auditLogs.some((a) => a.action === 'subscription.renewal_reminder_email_failed'),
    ).toBe(false);
    expect(h.fake.__transactions.filter((t) => t.status === 'PENDING')).toHaveLength(1);
  });
});
