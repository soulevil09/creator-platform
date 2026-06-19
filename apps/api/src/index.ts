import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { APP_NAME, SUPPORTED_CURRENCIES, SUPPORTED_LOCALES } from '@creator-platform/shared';
import { env } from './lib/env.js';
import { prisma as defaultPrisma, type PrismaClient } from './lib/prisma.js';
import { createResendEmailer, type Emailer } from './lib/email.js';
import { createAuthService } from './modules/auth/auth.service.js';
import authRoutes from './modules/auth/auth.routes.js';

const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);

export interface BuildServerOptions {
  /** Override the DB client (tests inject a mock). */
  prisma?: PrismaClient;
  /** Override the transactional emailer (tests inject a fake). */
  emailer?: Emailer;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const prisma = opts.prisma ?? defaultPrisma;
  const emailer = opts.emailer ?? createResendEmailer();

  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  // CORS: browser requests only from the configured app origin, with cookies.
  await app.register(cors, { origin: env.APP_URL, credentials: true });

  // Cookie parsing must come before JWT (JWT reads tokens from cookies).
  await app.register(cookie);

  // Two namespaced JWT instances — separate secrets + cookies for access vs
  // refresh tokens. Gives reply.accessJwtSign / request.accessJwtVerify, etc.
  await app.register(jwt, {
    namespace: 'access',
    secret: env.JWT_SECRET,
    cookie: { cookieName: 'access_token', signed: false },
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });
  await app.register(jwt, {
    namespace: 'refresh',
    secret: env.JWT_REFRESH_SECRET,
    cookie: { cookieName: 'refresh_token', signed: false },
    sign: { expiresIn: env.JWT_REFRESH_EXPIRES_IN },
  });

  // Rate limiting is opt-in per route (register/login set their own limits).
  await app.register(rateLimit, { global: false });

  // Liveness/readiness probe.
  app.get('/health', async () => ({
    status: 'ok',
    service: APP_NAME,
    currencies: SUPPORTED_CURRENCIES,
    locales: SUPPORTED_LOCALES,
    timestamp: new Date().toISOString(),
  }));

  const authService = createAuthService({ prisma, emailer });
  await app.register(authRoutes, { prefix: '/api/auth', service: authService });

  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only boot the server when run directly (not when imported by tests).
if (env.NODE_ENV !== 'test') {
  void start();
}
