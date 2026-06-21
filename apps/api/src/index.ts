import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { APP_NAME, SUPPORTED_CURRENCIES, SUPPORTED_LOCALES } from '@creator-platform/shared';
import { env } from './lib/env.js';
import { prisma as defaultPrisma, type PrismaClient } from './lib/prisma.js';
import { createResendEmailer, type Emailer } from './lib/email.js';
import { createS3StorageClient, type StorageClient } from './lib/storage.js';
import { createAuthService } from './modules/auth/auth.service.js';
import authRoutes from './modules/auth/auth.routes.js';
import { createOnboardingService } from './modules/onboarding/onboarding.service.js';
import onboardingRoutes from './modules/onboarding/onboarding.routes.js';

/** Max reference-image upload size, shared by the multipart limit (10 MB). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);

export interface BuildServerOptions {
  /** Override the DB client (tests inject a mock). */
  prisma?: PrismaClient;
  /** Override the transactional emailer (tests inject a fake). */
  emailer?: Emailer;
  /** Override the object-storage client (tests inject an in-memory fake). */
  storage?: StorageClient;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const prisma = opts.prisma ?? defaultPrisma;
  const emailer = opts.emailer ?? createResendEmailer();
  const storage = opts.storage ?? createS3StorageClient();

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

  // Multipart uploads (reference images). attachFieldsToBody:false keeps the
  // raw stream available so routes pull the single file via request.file()
  // without buffering the whole body into request.body. throwFileSizeLimit is
  // off so an over-limit file truncates (→ handled as 400) instead of 413.
  await app.register(multipart, {
    attachFieldsToBody: false,
    throwFileSizeLimit: false,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

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

  const onboardingService = createOnboardingService({
    prisma,
    storage,
    bucket: env.STORAGE_BUCKET,
  });
  await app.register(onboardingRoutes, {
    prefix: '/api/onboarding',
    service: onboardingService,
  });

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
