// =============================================================================
// Sentry wiring for the API (Session 13, D3).
//
// The SDK runs for real here, against an in-memory transport (no network): a
// route that fails with a 5xx must produce one event, scrubbed; a 4xx must
// produce none; and without a DSN nothing initialises at all.
// =============================================================================
import * as Sentry from '@sentry/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../index.js';
import type { PrismaClient } from './prisma.js';
import { createFakeEmailer, createFakePrisma } from '../test/fake-prisma.js';
import { initSentry, replyStatus, shouldReport } from './sentry.js';

const sent: string[] = [];

/** In-memory transport: keeps the serialized envelope, sends nothing. */
const memoryTransport = () => ({
  send: async (envelope: unknown) => {
    sent.push(JSON.stringify(envelope));
    return {};
  },
  flush: async () => true,
});

const config = {
  SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
  SENTRY_ENVIRONMENT: 'test',
  SENTRY_RELEASE: 'abc1234',
  SENTRY_TRACES_SAMPLE_RATE: 0,
};

async function makeApp() {
  const app = await buildServer({
    prisma: createFakePrisma() as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage: {
      uploadFile: vi.fn(async (_b: string, key: string) => key),
      getSignedUrl: vi.fn(async () => 'https://signed.example/x'),
      getObject: vi.fn(async () => Buffer.from('RAW')),
      deleteFile: vi.fn(async () => {}),
    },
    images: {
      getDimensions: vi.fn(async () => ({ width: 1, height: 1 })),
      watermark: vi.fn(async (b: Buffer) => b),
    },
  });
  app.post('/__test/boom', async () => {
    throw new Error('db exploded for victim@example.com at https://x.test/o?X-Amz-Signature=abc');
  });
  app.get('/__test/teapot', async () => {
    const err = new Error('client mistake') as Error & { statusCode: number };
    err.statusCode = 418;
    throw err;
  });
  return app;
}

describe('without a DSN', () => {
  it('initSentry is a no-op', () => {
    expect(initSentry({ ...config, SENTRY_DSN: '' })).toBe(false);
    expect(Sentry.isInitialized()).toBe(false);
  });
});

describe('with a DSN (in-memory transport)', () => {
  beforeAll(() => {
    expect(initSentry(config, { transport: memoryTransport })).toBe(true);
  });
  afterAll(async () => {
    await Sentry.close();
  });
  beforeEach(() => {
    sent.length = 0;
  });

  it('a 5xx is reported once, with no body, cookie, auth header, email or signed-URL query', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/__test/boom?token=verify-secret',
      headers: {
        cookie: 'access_token=jwt-cookie-value',
        authorization: 'Bearer jwt-bearer-value',
        'x-payout-cron-secret': 'cron-secret-value',
        'x-forwarded-for': '203.0.113.9',
      },
      payload: { password: 'body-password-value' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    await Sentry.flush(2000);

    const events = sent.filter((envelope) => envelope.includes('"exception"'));
    expect(events).toHaveLength(1);
    const payload = events[0];
    expect(payload).toContain('abc1234'); // release
    for (const needle of [
      'victim@example.com',
      'X-Amz-Signature',
      'verify-secret',
      'jwt-cookie-value',
      'jwt-bearer-value',
      'cron-secret-value',
      '203.0.113.9',
      'body-password-value',
    ]) {
      expect(payload, needle).not.toContain(needle);
    }
  });

  it('a 4xx is never reported', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/__test/teapot' });
    expect(res.statusCode).toBe(418);
    await Sentry.flush(2000);
    expect(sent.filter((envelope) => envelope.includes('"exception"'))).toHaveLength(0);
  });

  it('a handled 4xx route (validation) is never reported', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(res.statusCode).toBe(400);
    await Sentry.flush(2000);
    expect(sent.filter((envelope) => envelope.includes('"exception"'))).toHaveLength(0);
  });
});

describe('shouldReport', () => {
  it('reports 5xx and unset (thrown) statuses, never 4xx', () => {
    expect(shouldReport(new Error('x'), 200)).toBe(true);
    expect(replyStatus(new Error('x'), 200)).toBe(500);
    expect(shouldReport(new Error('x'), 503)).toBe(true);
    expect(shouldReport(Object.assign(new Error('x'), { statusCode: 404 }), 200)).toBe(false);
    expect(shouldReport(new Error('x'), 429)).toBe(false);
  });
});
