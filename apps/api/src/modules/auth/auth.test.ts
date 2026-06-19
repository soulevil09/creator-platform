// Auth integration + middleware unit tests.
//
// These run with NO real database and NO real email provider: we inject an
// in-memory Prisma fake and a fake emailer into buildServer(), and drive the
// HTTP layer with Fastify's `inject`. This keeps the suite fast and CI-green
// (no external services) while exercising the full request → cookie flow.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { Emailer } from '../../lib/email.js';
import { authenticate, authorize } from '../../middleware/auth.js';

// ── In-memory fakes ──────────────────────────────────────────────────────────
interface FakeUser {
  id: string;
  email: string;
  passwordHash: string;
  role: 'ADMIN' | 'MODEL' | 'SUBSCRIBER';
  displayName: string;
  isVerified: boolean;
  verifyToken: string | null;
  verifyTokenExpiresAt: Date | null;
  refreshTokenHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function createFakePrisma() {
  const users: FakeUser[] = [];
  let seq = 0;
  const match = (u: FakeUser, where: Record<string, unknown>) =>
    (where.id !== undefined && u.id === where.id) ||
    (where.email !== undefined && u.email === where.email) ||
    (where.verifyToken !== undefined && u.verifyToken === where.verifyToken);

  const client = {
    user: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        users.find((u) => match(u, where)) ?? null,
      create: async ({ data }: { data: Partial<FakeUser> }) => {
        const now = new Date();
        const user = {
          refreshTokenHash: null,
          verifyToken: null,
          verifyTokenExpiresAt: null,
          isVerified: false,
          ...data,
          id: `u_${++seq}`,
          createdAt: now,
          updatedAt: now,
        } as FakeUser;
        users.push(user);
        return user;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error('record not found');
        Object.assign(user, data, { updatedAt: new Date() });
        return user;
      },
    },
    __users: users,
  };
  return client;
}

function createFakeEmailer() {
  const sent: Array<{ to: string; token: string }> = [];
  const emailer: Emailer = {
    sendVerificationEmail: vi.fn(async (to: string, token: string) => {
      sent.push({ to, token });
    }),
  };
  return { emailer, sent };
}

type FakePrisma = ReturnType<typeof createFakePrisma>;

async function makeApp(prisma: FakePrisma, emailer: Emailer) {
  return buildServer({ prisma: prisma as unknown as PrismaClient, emailer });
}

/** Pull a single cookie value out of an inject response. */
function cookieValue(
  res: { cookies: Array<{ name: string; value: string }> },
  name: string,
): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}

const validRegister = {
  email: 'jane@example.com',
  password: 'supersecret',
  displayName: 'Jane',
  role: 'model' as const,
};

// ── Integration: registration & verification ─────────────────────────────────
describe('POST /api/auth/register', () => {
  let prisma: FakePrisma;
  let emailer: Emailer;
  let sent: Array<{ to: string; token: string }>;

  beforeEach(() => {
    prisma = createFakePrisma();
    ({ emailer, sent } = createFakeEmailer());
  });

  it('creates an unverified user, stores a hash, and sends a verification email', async () => {
    const app = await makeApp(prisma, emailer);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegister,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: 'model', message: 'Verification email sent' });
    expect(res.json().userId).toBeTruthy();
    // No token leaks into the body.
    expect(JSON.stringify(res.json())).not.toMatch(/token/i);

    const stored = prisma.__users[0];
    expect(stored.isVerified).toBe(false);
    expect(stored.passwordHash).not.toBe(validRegister.password);
    expect(stored.role).toBe('MODEL');
    expect(stored.verifyToken).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: validRegister.email });
  });

  it('rejects a duplicate email with 409 and does NOT send a second email', async () => {
    const app = await makeApp(prisma, emailer);
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: validRegister });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: validRegister,
    });

    expect(res.statusCode).toBe(409);
    expect(prisma.__users).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('rejects role "admin" with 400', async () => {
    const app = await makeApp(prisma, emailer);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegister, role: 'admin' },
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.__users).toHaveLength(0);
  });

  it('rejects a password shorter than 8 chars with 400', async () => {
    const app = await makeApp(prisma, emailer);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...validRegister, password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/auth/verify-email', () => {
  it('verifies a user with a valid token then rejects reuse', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);

    await app.inject({ method: 'POST', url: '/api/auth/register', payload: validRegister });
    const token = prisma.__users[0].verifyToken!;

    const ok = await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ message: 'Email verified' });
    expect(prisma.__users[0].isVerified).toBe(true);
    expect(prisma.__users[0].verifyToken).toBeNull();

    // Token is one-time use.
    const reuse = await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}` });
    expect(reuse.statusCode).toBe(400);
  });

  it('rejects an unknown token with 400', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);
    const res = await app.inject({ method: 'GET', url: '/api/auth/verify-email?token=nope' });
    expect(res.statusCode).toBe(400);
  });
});

// ── Integration: login / me / refresh / logout ───────────────────────────────
describe('login flow', () => {
  async function registerAndVerify(app: Awaited<ReturnType<typeof makeApp>>, prisma: FakePrisma) {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: validRegister });
    const token = prisma.__users[0].verifyToken!;
    await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}` });
  }

  it('rejects login for an unverified user with 403', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: validRegister });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: validRegister.email, password: validRegister.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Email not verified' });
  });

  it('rejects a wrong password with 401', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);
    await registerAndVerify(app, prisma);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: validRegister.email, password: 'wrongpassword' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logs in a verified user, setting httpOnly cookies and NO body tokens', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);
    await registerAndVerify(app, prisma);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: validRegister.email, password: validRegister.password },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: prisma.__users[0].id,
      role: 'model',
      displayName: 'Jane',
    });
    expect(JSON.stringify(res.json())).not.toMatch(/token/i);

    const access = res.cookies.find((c) => c.name === 'access_token');
    const refresh = res.cookies.find((c) => c.name === 'refresh_token');
    expect(access?.httpOnly).toBe(true);
    expect(access?.sameSite).toBe('Strict');
    expect(refresh?.httpOnly).toBe(true);
    // The refresh token is persisted only as a hash.
    expect(prisma.__users[0].refreshTokenHash).toBeTruthy();
    expect(prisma.__users[0].refreshTokenHash).not.toBe(refresh?.value);
  });

  it('GET /me returns 401 without a cookie and the profile with one', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);
    await registerAndVerify(app, prisma);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: validRegister.email, password: validRegister.password },
    });
    const accessToken = cookieValue(login, 'access_token')!;

    const unauth = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(unauth.statusCode).toBe(401);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { access_token: accessToken },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      userId: prisma.__users[0].id,
      email: validRegister.email,
      role: 'model',
      displayName: 'Jane',
      isVerified: true,
    });
  });

  it('refresh rotates tokens and invalidates the old refresh token', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);
    await registerAndVerify(app, prisma);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: validRegister.email, password: validRegister.password },
    });
    const oldRefresh = cookieValue(login, 'refresh_token')!;
    const hashAfterLogin = prisma.__users[0].refreshTokenHash;

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refresh_token: oldRefresh },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toEqual({ message: 'Token refreshed' });
    expect(cookieValue(refreshed, 'access_token')).toBeTruthy();
    // Stored hash was rotated.
    expect(prisma.__users[0].refreshTokenHash).not.toBe(hashAfterLogin);

    // The old refresh token no longer matches the stored hash.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refresh_token: oldRefresh },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('refresh without a cookie returns 401', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears the stored refresh hash and requires auth', async () => {
    const prisma = createFakePrisma();
    const { emailer } = createFakeEmailer();
    const app = await makeApp(prisma, emailer);
    await registerAndVerify(app, prisma);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: validRegister.email, password: validRegister.password },
    });
    const accessToken = cookieValue(login, 'access_token')!;

    const unauth = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(unauth.statusCode).toBe(401);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { access_token: accessToken },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.__users[0].refreshTokenHash).toBeNull();
  });
});

// ── Unit: middleware ─────────────────────────────────────────────────────────
function fakeReply() {
  return {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    code(c: number) {
      this.statusCode = c;
      return this;
    },
    async send(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

describe('authenticate middleware', () => {
  it('passes through when the access token verifies', async () => {
    const reply = fakeReply();
    const request = {
      accessJwtVerify: vi.fn(async () => ({ userId: 'u_1', role: 'model' })),
    } as unknown as FastifyRequest;
    await authenticate(request, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBeUndefined();
  });

  it('responds 401 when verification throws', async () => {
    const reply = fakeReply();
    const request = {
      accessJwtVerify: vi.fn(async () => {
        throw new Error('no token');
      }),
    } as unknown as FastifyRequest;
    await authenticate(request, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Unauthorized' });
  });
});

describe('authorize middleware', () => {
  // The hook is typed with a Fastify `this`; in unit tests we call it as a plain
  // function, so cast to a bare callable.
  type BareHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

  it('allows a request whose role is permitted', async () => {
    const reply = fakeReply();
    const request = { user: { userId: 'u_1', role: 'admin' } } as unknown as FastifyRequest;
    await (authorize('admin', 'model') as unknown as BareHook)(
      request,
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBeUndefined();
  });

  it('forbids a request whose role is not permitted', async () => {
    const reply = fakeReply();
    const request = { user: { userId: 'u_1', role: 'subscriber' } } as unknown as FastifyRequest;
    await (authorize('admin', 'model') as unknown as BareHook)(
      request,
      reply as unknown as FastifyReply,
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({ error: 'Forbidden' });
  });
});
