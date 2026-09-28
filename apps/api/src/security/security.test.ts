// =============================================================================
// Security hardening tests (Session 12 — D1, D2, D4).
//
//   D1  trustProxy: honoured only when configured, never spoofable by default;
//       JSON bodies capped at 1 MB.
//   D2  security headers on every reply (HSTS in production only), and an
//       error surface that never leaks a 5xx message, a stack, or input.
//   D4  login does the same bcrypt work for unknown and known emails, and a
//       token signed with any algorithm but HS256 is refused.
//
// Same harness as every other suite: the shared in-memory Prisma fake through
// `buildServer`, driven with `inject`. Routes that exist only to prove a
// property (an echo of `request.ip`, a throwing handler) are registered on the
// test's own instance, never on the real server.
// =============================================================================
import { createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer, type BuildServerOptions } from '../index.js';
import type { PrismaClient } from '../lib/prisma.js';
import type { StorageClient } from '../lib/storage.js';
import type { ImageProcessor } from '../lib/image.js';
import { parseTrustProxy } from '../lib/env.js';
import { createAuthService } from '../modules/auth/auth.service.js';
import {
  createFakeEmailer,
  createFakePrisma,
  seedGenerationJob,
  type FakePrisma,
} from '../test/fake-prisma.js';

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

async function makeApp(opts: Partial<BuildServerOptions> = {}) {
  const prisma = createFakePrisma();
  const app = await buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage: fakeStorage,
    images: fakeImages,
    ...opts,
  });
  return { app, prisma };
}

/** Seed a user row directly and sign an access token for it. */
function signIn(
  app: Awaited<ReturnType<typeof buildServer>>,
  prisma: FakePrisma,
  id: string,
  role: 'subscriber' | 'model' | 'admin',
): string {
  const now = new Date();
  prisma.__users.push({
    id,
    email: `${id}@example.com`,
    passwordHash: 'unused',
    role: role.toUpperCase() as 'SUBSCRIBER' | 'MODEL' | 'ADMIN',
    displayName: id,
    isVerified: true,
    verifyToken: null,
    verifyTokenExpiresAt: null,
    refreshTokenHash: null,
    preferredLocale: 'en',
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return app.jwt.access.sign({ userId: id, role });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
describe('D1 — parseTrustProxy', () => {
  it('defaults to false, and treats "false"/"0" as false', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
  });

  it('parses a hop count and a comma-separated list of IPs/CIDRs', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1 ,::1,fd00::/8')).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
      '::1',
      'fd00::/8',
    ]);
  });

  it('refuses `true` and anything malformed rather than guessing', () => {
    expect(() => parseTrustProxy('true')).toThrow(/not allowed/);
    expect(() => parseTrustProxy('TRUE')).toThrow(/not allowed/);
    expect(() => parseTrustProxy('loopback')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('999.1.1.1')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('11')).toThrow(/hop count/);
  });
});

describe('D1 — client IP behind a proxy', () => {
  const SPOOFED = '203.0.113.7';
  const OTHER = '203.0.113.8';

  /** An invalid login body — 400 before bcrypt, but still counted by the limiter. */
  const login = (app: Awaited<ReturnType<typeof buildServer>>, xff: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': xff },
      payload: {},
    });

  async function withIpEcho(trustProxy: BuildServerOptions['trustProxy']) {
    const { app } = await makeApp({ trustProxy });
    app.get('/__test/ip', async (request) => ({ ip: request.ip }));
    return app;
  }

  it('TRUST_PROXY=1: X-Forwarded-For is the client, and the login limit counts against it', async () => {
    const app = await withIpEcho(1);

    const echo = await app.inject({
      method: 'GET',
      url: '/__test/ip',
      headers: { 'x-forwarded-for': SPOOFED },
    });
    expect(echo.json()).toEqual({ ip: SPOOFED });

    for (let i = 0; i < 10; i++) {
      expect((await login(app, SPOOFED)).statusCode).toBe(400);
    }
    expect((await login(app, SPOOFED)).statusCode).toBe(429);
    // A different client behind the same proxy has its own budget.
    expect((await login(app, OTHER)).statusCode).toBe(400);
  });

  it('TRUST_PROXY=1: a multi-hop X-Forwarded-For resolves to the right-most untrusted hop, not the client-supplied left-most', async () => {
    const app = await withIpEcho(1);

    // Socket = the one trusted proxy (inject's 127.0.0.1). Everything left of the
    // hop it appended was written by the client and must not choose the key.
    const echo = await app.inject({
      method: 'GET',
      url: '/__test/ip',
      headers: { 'x-forwarded-for': `1.1.1.1, ${SPOOFED}` },
    });
    expect(echo.json()).toEqual({ ip: SPOOFED });

    for (let i = 0; i < 10; i++) {
      expect((await login(app, `1.1.1.1, ${SPOOFED}`)).statusCode).toBe(400);
    }
    // A fresh forged left-most value does not buy a fresh budget.
    expect((await login(app, `9.9.9.9, ${SPOOFED}`)).statusCode).toBe(429);
    expect((await login(app, SPOOFED)).statusCode).toBe(429);
  });

  it('TRUST_PROXY unset: the header is ignored, so a spoofed value cannot reset the login budget', async () => {
    const app = await withIpEcho(undefined);

    const echo = await app.inject({
      method: 'GET',
      url: '/__test/ip',
      headers: { 'x-forwarded-for': SPOOFED },
    });
    expect(echo.json()).toEqual({ ip: '127.0.0.1' });

    for (let i = 0; i < 10; i++) {
      expect((await login(app, SPOOFED)).statusCode).toBe(400);
    }
    // New spoofed address, same socket → same exhausted budget.
    expect((await login(app, OTHER)).statusCode).toBe(429);
    expect((await login(app, '198.51.100.1')).statusCode).toBe(429);
  });
});

describe('D1 — request-size limit', () => {
  it('answers 413 payload_too_large for a JSON body over 1 MB', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@example.com', padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('still accepts a normal-sized JSON body', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever-password' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// =============================================================================
describe('D2 — security headers', () => {
  const expectHardened = (headers: Record<string, unknown>) => {
    expect(headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-resource-policy']).toBe('same-site');
    expect(headers['x-frame-options']).toBe('DENY');
  };

  it('are set on /health and on an authenticated route; no HSTS outside production', async () => {
    const { app, prisma } = await makeApp({ hsts: false });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expectHardened(health.headers);
    expect(health.headers['strict-transport-security']).toBeUndefined();

    const token = signIn(app, prisma, 'u_sub', 'subscriber');
    const balance = await app.inject({
      method: 'GET',
      url: '/api/wallet/balance',
      cookies: { access_token: token },
    });
    expect(balance.statusCode).toBe(200);
    expectHardened(balance.headers);
    expect(balance.headers['strict-transport-security']).toBeUndefined();
  });

  it('the default follows NODE_ENV: the test environment sends no HSTS', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS (1 year, includeSubDomains) in production', async () => {
    const { app, prisma } = await makeApp({ hsts: true });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    const token = signIn(app, prisma, 'u_sub', 'subscriber');
    const balance = await app.inject({
      method: 'GET',
      url: '/api/wallet/balance',
      cookies: { access_token: token },
    });
    expect(balance.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('the watermarked image stream keeps no-store and a same-site CORP the web origin can load', async () => {
    const { app, prisma } = await makeApp();
    const token = signIn(app, prisma, 'u_sub', 'subscriber');
    const job = seedGenerationJob(prisma, { subscriberId: 'u_sub', modelId: 'm_1' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/generations/${job.id}/image`,
      cookies: { access_token: token },
      // The web app's origin: same site as the API (ports do not change site).
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});

describe('D2 — error surface', () => {
  const LEAKY = 'SELECT * FROM "User" WHERE "passwordHash" = $1 — secret=hunter2';

  it('a thrown handler error answers exactly { error: internal_error } and is logged server-side', async () => {
    const { app } = await makeApp();
    let logged: unknown;
    app.get('/__test/throw', async (request) => {
      vi.spyOn(request.log, 'error').mockImplementation((obj: unknown) => {
        logged = obj;
      });
      throw new Error(LEAKY);
    });

    const res = await app.inject({ method: 'GET', url: '/__test/throw' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.body).not.toContain('SELECT');
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('stack');
    // The full error went to the server log instead.
    expect((logged as { err: Error }).err.message).toBe(LEAKY);
  });

  it('an error thrown from a preHandler cannot leak either', async () => {
    const { app } = await makeApp();
    app.get(
      '/__test/prehandler-throw',
      {
        preHandler: async () => {
          throw Object.assign(new Error(LEAKY), { code: 'P2010' });
        },
      },
      async () => ({ unreachable: true }),
    );
    const res = await app.inject({ method: 'GET', url: '/__test/prehandler-throw' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.body).not.toContain('P2010');
  });

  it('an explicit 5xx status is still masked', async () => {
    const { app } = await makeApp();
    app.get('/__test/throw-503', async () => {
      throw Object.assign(new Error(`provider said: ${LEAKY}`), { statusCode: 503 });
    });
    const res = await app.inject({ method: 'GET', url: '/__test/throw-503' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
  });

  it('malformed JSON is a 400 bad_request that does not echo the input', async () => {
    const { app } = await makeApp();
    const payload = '{"email": "x@example.com", "password": <<ECHO-ME>>';
    for (const url of ['/api/auth/login', '/api/payments/woovi/webhook']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_request' });
      expect(res.body).not.toContain('ECHO-ME');
    }
  });

  it('unknown routes answer 404 { error: not_found }', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('other 4xx errors keep their existing bodies (a rate-limit 429)', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ statusCode: 429, error: 'Too Many Requests' });
  });
});

// =============================================================================
describe('D4 — login timing does not reveal whether an email exists', () => {
  it('runs bcrypt.compare exactly once on the unknown-email and the wrong-password paths', async () => {
    const prisma = createFakePrisma();
    const service = createAuthService({
      prisma: prisma as unknown as PrismaClient,
      emailer: createFakeEmailer(),
    });
    const now = new Date();
    prisma.__users.push({
      id: 'u_known',
      email: 'known@example.com',
      passwordHash: bcrypt.hashSync('the-right-password', 4),
      role: 'SUBSCRIBER',
      displayName: 'Known',
      isVerified: true,
      verifyToken: null,
      verifyTokenExpiresAt: null,
      refreshTokenHash: null,
      preferredLocale: 'en',
      suspendedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const compare = vi.spyOn(bcrypt, 'compare');

    await expect(
      service.validateCredentials('unknown@example.com', 'whatever'),
    ).rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
    expect(compare).toHaveBeenCalledTimes(1);
    // …against a real cost-12 hash, so the work matches a real account's.
    expect(bcrypt.getRounds(compare.mock.calls[0][1] as string)).toBe(12);

    compare.mockClear();
    await expect(
      service.validateCredentials('known@example.com', 'wrong-password'),
    ).rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
    expect(compare).toHaveBeenCalledTimes(1);
  });
});

describe('D4 — JWT algorithm is pinned to HS256', () => {
  const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

  function forge(alg: 'HS256' | 'HS384' | 'HS512', secret: string, payload: object): string {
    const digest = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[alg];
    const head = `${b64url({ alg, typ: 'JWT' })}.${b64url(payload)}`;
    const signature = createHmac(digest, secret).update(head).digest('base64url');
    return `${head}.${signature}`;
  }

  it('rejects a token signed with HS512 (same secret) on GET /api/auth/me, accepts HS256', async () => {
    const { app, prisma } = await makeApp();
    signIn(app, prisma, 'u_sub', 'subscriber');
    const secret = process.env.JWT_SECRET!;
    const payload = {
      userId: 'u_sub',
      role: 'subscriber',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };

    const hs512 = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { access_token: forge('HS512', secret, payload) },
    });
    expect(hs512.statusCode).toBe(401);

    const hs384 = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { access_token: forge('HS384', secret, payload) },
    });
    expect(hs384.statusCode).toBe(401);

    // Control: the identical claims under HS256 are accepted, so the 401s
    // above are about the algorithm and nothing else.
    const hs256 = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { access_token: forge('HS256', secret, payload) },
    });
    expect(hs256.statusCode).toBe(200);
  });
});
