// HTTP layer for payments: two checkout endpoints (authenticated, subscriber
// only, rate limited) and two provider webhooks (unauthenticated, but signed).
//
// Two things this layer owns that the service cannot:
//
//   1. The raw request bytes. A content-type parser scoped to this plugin keeps
//      them on `request.rawBody` so signature verification hashes exactly what
//      the provider signed. Fastify encapsulates parsers per plugin, so no
//      other module's JSON handling changes.
//
//   2. Webhook response semantics. Providers retry on any non-2xx, so a
//      duplicate delivery or an unknown correlation id answers 200 (there is
//      nothing a retry could fix), while a bad signature answers 400 and a
//      genuine server fault answers 500 so the provider does retry.
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import type { PaymentChannel } from '@creator-platform/shared';
import { authenticate, authorize } from '../../middleware/auth.js';
import { PaymentError, type PaymentsService } from './payments.service.js';
import { PaymentProviderConfigError } from './provider.interface.js';
import { creditsCheckoutSchema, subscriptionCheckoutSchema } from './payments.schema.js';

export interface PaymentRoutesOptions extends FastifyPluginOptions {
  service: PaymentsService;
}

/** Checkout is charge-creating, so it is capped per authenticated user. */
const CHECKOUT_RATE_LIMIT = {
  max: 10,
  timeWindow: '1 minute',
  // Key on the caller, not the IP: two subscribers behind one NAT must not
  // exhaust each other's budget, and one account cannot spam from many IPs.
  keyGenerator: (request: { user?: { userId?: string }; ip: string }) =>
    request.user?.userId ?? request.ip,
};

const subscriberOnly = { preHandler: [authenticate, authorize('subscriber')] };

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PaymentError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err instanceof PaymentProviderConfigError) {
    // A misconfigured channel is our fault, not the caller's — and the message
    // names an env var, so it must not reach the client.
    return reply.code(503).send({ error: 'Payment channel is not available' });
  }
  throw err;
}

export default async function paymentRoutes(
  app: FastifyInstance,
  opts: PaymentRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // Keep the raw bytes for signature verification. Encapsulated to this plugin.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      request.rawBody = body;
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // ── POST /checkout/subscription ───────────────────────────────────────────
  app.post(
    '/checkout/subscription',
    { ...subscriberOnly, config: { rateLimit: CHECKOUT_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = subscriptionCheckoutSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.createSubscriptionCheckout({
          userId: request.user.userId,
          modelId: parsed.data.modelId,
          tier: parsed.data.tier,
          provider: parsed.data.provider,
        });
        return reply.code(201).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── POST /checkout/credits ────────────────────────────────────────────────
  app.post(
    '/checkout/credits',
    { ...subscriberOnly, config: { rateLimit: CHECKOUT_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = creditsCheckoutSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.createCreditsCheckout({
          userId: request.user.userId,
          packId: parsed.data.packId,
          provider: parsed.data.provider,
        });
        return reply.code(201).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /** Shared webhook handler — the channel is the only difference. */
  function webhookHandler(channel: PaymentChannel) {
    return async (
      request: { rawBody?: Buffer; headers: Record<string, string | string[] | undefined> },
      reply: FastifyReply,
    ) => {
      const rawBody = request.rawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: 'Missing request body' });
      }
      try {
        const outcome = await service.handleWebhook(channel, rawBody, request.headers);
        return reply.code(200).send({
          received: true,
          processed: outcome.processed,
          duplicate: outcome.duplicate,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    };
  }

  // ── Provider webhooks (no auth — authenticity comes from the signature) ───
  // Rate limited by IP as a cheap flood guard; the signature check runs before
  // any database access, so rejected traffic is nearly free either way.
  const webhookOpts = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.post('/woovi/webhook', webhookOpts, webhookHandler('pix'));
  app.post('/nowpayments/webhook', webhookOpts, webhookHandler('crypto'));
}
