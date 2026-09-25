// HTTP layer for the subscription lifecycle: three subscriber-facing endpoints
// and one cron-triggered sweep.
//
// ── Why /renewals/run is guarded by a service secret, not a JWT ─────────────
// Identical reasoning to `POST /api/payouts/run` (Session 06): the caller is a
// GitHub Actions cron job with no user session, so it has no JWT to present and
// no way to obtain one without holding a real password. A shared secret in a
// header authenticates the *machine* honestly, is compared with
// `crypto.timingSafeEqual` rather than `===`, is checked before any database
// access, and rotates in one GitHub secret.
//
// The rate limit is 4/hour rather than the payout run's 2/hour: this job runs
// daily and may legitimately need a same-day retry after a transient provider
// outage, which the weekly payout run does not.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../lib/env.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { PaymentProviderConfigError } from '../payments/provider.interface.js';
import { SubscriptionError, type SubscriptionsService } from './subscriptions.service.js';
import { modelIdParamsSchema } from './subscriptions.schema.js';

export interface SubscriptionRoutesOptions extends FastifyPluginOptions {
  service: SubscriptionsService;
}

const CRON_SECRET_HEADER = 'x-renewal-cron-secret';

/** Constant-time compare that tolerates differing lengths without throwing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof SubscriptionError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err instanceof PaymentProviderConfigError) {
    // A misconfigured channel is our fault, not the caller's — and the message
    // names an env var, so it must not reach the client.
    return reply.code(503).send({ error: 'Subscriptions are not available' });
  }
  throw err;
}

const subscriberOnly = { preHandler: [authenticate, authorize('subscriber')] };
const READ_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };
/**
 * Keyed on the caller, not the IP — one NAT must not share a budget. Attached
 * via `app.rateLimit()` AFTER `authenticate` (Session 11.5): the
 * `config.rateLimit` form runs at `onRequest`, before `request.user` is set,
 * so it silently keyed on the IP.
 */
const WRITE_RATE_LIMIT = {
  max: 20,
  timeWindow: '1 hour',
  keyGenerator: (request: { user?: { userId?: string }; ip: string }) =>
    request.user?.userId ?? request.ip,
};

export default async function subscriptionRoutes(
  app: FastifyInstance,
  opts: SubscriptionRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── GET /me ───────────────────────────────────────────────────────────────
  // The subscriber id comes from the verified JWT, never a path or query
  // parameter, so there is no other subscriber's list to ask for.
  app.get(
    '/me',
    { ...subscriberOnly, config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const result = await service.listMine(request.user.userId);
      return reply.code(200).send(result);
    },
  );

  // ── POST /model/:modelId/cancel ───────────────────────────────────────────
  // Stops renewal; access continues through the period already paid for.
  app.post(
    '/model/:modelId/cancel',
    { preHandler: [...subscriberOnly.preHandler, app.rateLimit(WRITE_RATE_LIMIT)] },
    async (request, reply) => {
      const parsed = modelIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.cancel(request.user.userId, parsed.data.modelId);
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── POST /model/:modelId/resume ───────────────────────────────────────────
  app.post(
    '/model/:modelId/resume',
    { preHandler: [...subscriberOnly.preHandler, app.rateLimit(WRITE_RATE_LIMIT)] },
    async (request, reply) => {
      const parsed = modelIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.resume(request.user.userId, parsed.data.modelId);
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── POST /renewals/run ────────────────────────────────────────────────────
  // Cron-only doesn't mean unguarded: a leaked secret must not be able to
  // trigger unlimited runs, so this is capped by IP on top of the secret check.
  app.post(
    '/renewals/run',
    {
      config: { rateLimit: { max: 4, timeWindow: '1 hour' } },
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const provided = request.headers[CRON_SECRET_HEADER];
        const expected = env.SUBSCRIPTION_RENEWAL_CRON_SECRET;
        // An unconfigured secret leaves the endpoint closed, never open.
        if (typeof provided !== 'string' || !expected || !secretMatches(provided, expected)) {
          await reply.code(401).send({ error: 'Unauthorized' });
        }
      },
    },
    async (_request, reply) => {
      try {
        const summary = await service.runRenewals();
        return reply.code(200).send(summary);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
