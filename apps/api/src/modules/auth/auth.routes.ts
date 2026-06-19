// HTTP layer for auth. Owns request parsing, JWT signing, httpOnly cookies, and
// per-route rate limits; delegates all persistence/crypto to the auth service.
//
// Tokens are NEVER returned in a response body — only set as httpOnly cookies.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import type { JwtPayload } from '@creator-platform/shared';
import { env, ACCESS_COOKIE_MAX_AGE, REFRESH_COOKIE_MAX_AGE } from '../../lib/env.js';
import { authenticate } from '../../middleware/auth.js';
import { AuthError, type AuthService } from './auth.service.js';
import { loginSchema, registerSchema, verifyEmailSchema } from './auth.schema.js';

export interface AuthRoutesOptions extends FastifyPluginOptions {
  service: AuthService;
}

const cookieBase = {
  httpOnly: true,
  secure: env.isProduction,
  sameSite: 'strict' as const,
  path: '/',
};

/** Sign a fresh access+refresh pair and set both as httpOnly cookies. */
async function issueSession(reply: FastifyReply, payload: JwtPayload): Promise<string> {
  const accessToken = await reply.accessJwtSign(payload);
  // A unique nonce in the payload makes every refresh token distinct even when
  // two are issued in the same second (identical iat) — so rotation truly
  // invalidates the old token. The nonce is cast away; only userId/role are read.
  const refreshPayload = { ...payload, jti: randomBytes(16).toString('hex') };
  const refreshToken = await reply.refreshJwtSign(refreshPayload as JwtPayload);
  reply.setCookie('access_token', accessToken, { ...cookieBase, maxAge: ACCESS_COOKIE_MAX_AGE });
  reply.setCookie('refresh_token', refreshToken, { ...cookieBase, maxAge: REFRESH_COOKIE_MAX_AGE });
  return refreshToken;
}

function clearSession(reply: FastifyReply): void {
  reply.clearCookie('access_token', { path: '/' });
  reply.clearCookie('refresh_token', { path: '/' });
}

export default async function authRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── POST /register ────────────────────────────────────────────────────────
  app.post(
    '/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const { userId, role } = await service.register(parsed.data);
        return reply.code(201).send({ userId, role, message: 'Verification email sent' });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.status).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // ── GET /verify-email ─────────────────────────────────────────────────────
  app.get('/verify-email', async (request, reply) => {
    const parsed = verifyEmailSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid or expired verification token' });
    }
    try {
      await service.verifyEmail(parsed.data.token);
      return reply.code(200).send({ message: 'Email verified' });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  // ── POST /login ───────────────────────────────────────────────────────────
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const user = await service.validateCredentials(parsed.data.email, parsed.data.password);
        const payload: JwtPayload = { userId: user.userId, role: user.role };
        const refreshToken = await issueSession(reply, payload);
        await service.storeRefreshToken(user.userId, refreshToken);
        return reply
          .code(200)
          .send({ userId: user.userId, role: user.role, displayName: user.displayName });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.status).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // ── POST /refresh ─────────────────────────────────────────────────────────
  app.post('/refresh', async (request, reply) => {
    const presented = request.cookies.refresh_token;
    if (!presented) {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }
    let payload: JwtPayload;
    try {
      payload = await request.refreshJwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }
    try {
      await service.assertRefreshTokenValid(payload.userId, presented);
      const newPayload: JwtPayload = { userId: payload.userId, role: payload.role };
      const refreshToken = await issueSession(reply, newPayload);
      await service.storeRefreshToken(payload.userId, refreshToken);
      return reply.code(200).send({ message: 'Token refreshed' });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  // ── POST /logout (authenticated) ──────────────────────────────────────────
  app.post('/logout', { preHandler: authenticate }, async (request, reply) => {
    await service.clearRefreshToken(request.user.userId);
    clearSession(reply);
    return reply.code(200).send({ message: 'Logged out' });
  });

  // ── GET /me (authenticated) ───────────────────────────────────────────────
  app.get('/me', { preHandler: authenticate }, async (request, reply) => {
    try {
      const me = await service.getMe(request.user.userId);
      return reply.code(200).send(me);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });
}
