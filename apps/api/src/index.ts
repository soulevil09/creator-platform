import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import {
  APP_NAME,
  SUPPORTED_CURRENCIES,
  SUPPORTED_LOCALES,
  type PaymentChannel,
} from '@creator-platform/shared';
import { env } from './lib/env.js';
import { prisma as defaultPrisma, type PrismaClient } from './lib/prisma.js';
import { createResendEmailer, type Emailer } from './lib/email.js';
import { createS3StorageClient, type StorageClient } from './lib/storage.js';
import { createSharpImageProcessor, type ImageProcessor } from './lib/image.js';
import type { IPaymentProvider } from './modules/payments/provider.interface.js';
import { createAuthService } from './modules/auth/auth.service.js';
import authRoutes from './modules/auth/auth.routes.js';
import { createOnboardingService } from './modules/onboarding/onboarding.service.js';
import onboardingRoutes from './modules/onboarding/onboarding.routes.js';
import { createContentService } from './modules/content/content.service.js';
import contentRoutes from './modules/content/content.routes.js';
import { createWalletService } from './modules/wallet/wallet.service.js';
import walletRoutes from './modules/wallet/wallet.routes.js';
import { createPaymentsService } from './modules/payments/payments.service.js';
import paymentRoutes from './modules/payments/payments.routes.js';
import {
  assertPaymentProvidersConfigured,
  getPaymentProvider,
} from './modules/payments/provider.factory.js';
import { createPayoutsService } from './modules/payouts/payouts.service.js';
import payoutRoutes from './modules/payouts/payouts.routes.js';
import {
  assertPayoutProviderConfigured,
  getPayoutProvider,
} from './modules/payouts/provider.factory.js';
import type { IPayoutProvider } from './modules/payouts/provider.interface.js';
import { createSubscriptionsService } from './modules/subscriptions/subscriptions.service.js';
import subscriptionRoutes from './modules/subscriptions/subscriptions.routes.js';
import { createMessagingService } from './modules/messaging/messaging.service.js';
import messagingRoutes from './modules/messaging/messaging.routes.js';
import messagingWsRoutes from './modules/messaging/messaging.ws.js';
import { createConnectionRegistry } from './modules/messaging/connections.js';
import { createGenerationService } from './modules/generation/generation.service.js';
import generationRoutes from './modules/generation/generation.routes.js';
import {
  assertAIProviderConfigured,
  getAIProvider,
} from './modules/generation/provider.factory.js';
import type { IAIProvider } from './modules/generation/provider.interface.js';
import { createTraceRecorder } from './modules/protection/trace.js';
import { createStorageCleanupService } from './modules/storage-cleanup/storage-cleanup.service.js';
import storageCleanupRoutes from './modules/storage-cleanup/storage-cleanup.routes.js';

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
  /** Override the image processor (tests inject a fake to avoid sharp's binary). */
  images?: ImageProcessor;
  /** Override the payment-provider factory (tests inject stub adapters). */
  getPaymentProvider?: (channel: PaymentChannel) => IPaymentProvider;
  /** Override the payout-provider factory (tests inject a stub adapter). */
  getPayoutProvider?: () => IPayoutProvider;
  /** Override the AI-provider factory (tests inject the mock or a stub adapter). */
  getAIProvider?: () => IAIProvider;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const prisma = opts.prisma ?? defaultPrisma;
  const emailer = opts.emailer ?? createResendEmailer();
  const storage = opts.storage ?? createS3StorageClient();
  const images = opts.images ?? createSharpImageProcessor();
  const getProvider = opts.getPaymentProvider ?? getPaymentProvider;
  const getPayoutAdapter = opts.getPayoutProvider ?? getPayoutProvider;
  const getAIAdapter = opts.getAIProvider ?? getAIProvider;

  // Fail fast: an unknown PAYMENT_PROVIDER_* value must stop the process here,
  // not surface later as a failed checkout in production.
  if (!opts.getPaymentProvider) {
    assertPaymentProvidersConfigured();
  }
  // Same for PAYOUT_PROVIDER — a typo must not surface as a weekly payout run
  // that quietly does nothing.
  if (!opts.getPayoutProvider) {
    assertPayoutProviderConfigured();
  }
  // And for AI_PROVIDER — a typo must not surface as a 502 after a
  // subscriber's credits were debited.
  if (!opts.getAIProvider) {
    assertAIProviderConfigured();
  }

  // Message bodies must never reach a log line in plaintext (Session 07): this
  // is an adult-content platform, so a private message in an access log is a
  // disclosure, not a debugging convenience. Fastify logs no request body by
  // default; `redact` makes that explicit and survives anyone later adding a
  // body-logging serializer or logging a request object directly.
  const app = Fastify({
    logger:
      env.NODE_ENV !== 'test'
        ? {
            redact: {
              paths: ['req.body.text', 'body.text', 'message.body', 'msg.body'],
              remove: true,
            },
          }
        : false,
  });

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

  // ── Anti-leak (Session 09) ────────────────────────────────────────────────
  // One trace recorder for every image/video serve path. The content and
  // generation modules both mint their per-viewer codes through it, so there
  // is a single HMAC scheme and a single AuditLog shape to look a code up in.
  const trace = createTraceRecorder({ prisma, secret: env.WATERMARK_TRACE_SECRET });

  const contentService = createContentService({
    prisma,
    storage,
    images,
    bucket: env.STORAGE_BUCKET,
    trace,
  });
  await app.register(contentRoutes, {
    prefix: '/api/content',
    service: contentService,
  });

  const walletService = createWalletService({ prisma });
  await app.register(walletRoutes, { prefix: '/api/wallet', service: walletService });

  const paymentsService = createPaymentsService({
    prisma,
    wallet: walletService,
    // Session 04's granter, reused verbatim — every access grant goes through
    // this one primitive.
    grantContentAccess: contentService.grantContentAccess,
    getProvider,
    revenueShareModelPct: env.REVENUE_SHARE_MODEL_PCT,
  });
  await app.register(paymentRoutes, { prefix: '/api/payments', service: paymentsService });

  // Subscription lifecycle (Session 06.5). It creates no charges of its own —
  // it calls the payments module's single subscription-charge seam, so renewal
  // and checkout remain one code path into IPaymentProvider.
  const subscriptionsService = createSubscriptionsService({
    prisma,
    emailer,
    issueSubscriptionCharge: paymentsService.issueSubscriptionCharge,
    reminderDays: env.SUBSCRIPTION_RENEWAL_REMINDER_DAYS,
    gracePeriodDays: env.SUBSCRIPTION_GRACE_PERIOD_DAYS,
  });
  await app.register(subscriptionRoutes, {
    prefix: '/api/subscriptions',
    service: subscriptionsService,
  });

  // ── Messaging (Session 07) ────────────────────────────────────────────────
  // The connection registry is process-local: fan-out reaches only recipients
  // connected to THIS instance, which is correct for the single-instance MVP
  // deployment and needs a shared pub/sub layer before the API is scaled
  // horizontally (Open Item, Session 12/13). The service depends on the
  // `send` seam alone, so that swap does not reach into the module.
  const connections = createConnectionRegistry();
  const messagingService = createMessagingService({
    prisma,
    storage,
    bucket: env.STORAGE_BUCKET,
    connections,
  });
  await app.register(messagingRoutes, {
    prefix: '/api/messages',
    service: messagingService,
  });
  // Registered at the root, not under /api: the socket is a transport, not a
  // REST resource, and the upgrade path is what a client dials directly.
  await app.register(websocket);
  await app.register(messagingWsRoutes, { connections });

  const payoutsService = createPayoutsService({
    prisma,
    getProvider: getPayoutAdapter,
    minThresholdCents: env.PAYOUT_MIN_THRESHOLD_CENTS,
    payoutCurrency: env.PAYOUT_CURRENCY,
  });
  await app.register(payoutRoutes, { prefix: '/api/payouts', service: payoutsService });

  // ── AI image personalization (Session 08) ────────────────────────────────
  // Spends credits through Session 05's wallet (never a provider call of its
  // own), stores raw images through Session 03's storage client, and
  // watermarks on serve through Session 04's processor. `app.log` is handed in
  // so the module logs through the server's logger — and so the suite can
  // spy on it to prove the anchor prompt never reaches a log line.
  const generationService = createGenerationService({
    prisma,
    storage,
    images,
    bucket: env.STORAGE_BUCKET,
    wallet: walletService,
    getProvider: getAIAdapter,
    retentionDays: env.GENERATION_IMAGE_RETENTION_DAYS,
    trace,
    logger: app.log,
  });
  await app.register(generationRoutes, {
    prefix: '/api/generations',
    service: generationService,
  });

  // ── Storage hygiene (Session 09) ──────────────────────────────────────────
  // Daily cron-triggered sweep that purges the objects behind soft-deleted
  // Content and expired GenerationJob rows — the two orphan sources Sessions
  // 04 and 08 deferred. Same service-secret posture as the payout and renewal
  // runs; no JWT, no user.
  const storageCleanupService = createStorageCleanupService({
    prisma,
    storage,
    bucket: env.STORAGE_BUCKET,
  });
  await app.register(storageCleanupRoutes, {
    prefix: '/api/admin/storage',
    service: storageCleanupService,
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
