// HTTP layer for payouts: one model-facing read, one cron-triggered run, one
// provider IPN, and two admin reads.
//
// ── Why /run is guarded by a service secret, not an admin JWT ───────────────
// The caller is a GitHub Actions cron job. It has no user session, so it has no
// JWT to present and no way to obtain one without holding a real admin
// password. There is also no admin auth or dashboard yet — that is Session 11.
// A shared secret in a header is the honest fit: it authenticates the *caller*
// (a machine) rather than pretending a user is present, it is comparable in
// constant time, and it can be rotated in one GitHub secret. When Session 11
// lands an admin identity, a manually triggered run can sit behind the JWT and
// this endpoint stays what it is: the machine entrance.
//
// The secret is compared with `crypto.timingSafeEqual`, never `===`, and the
// check runs before any database access, so a wrong secret costs one buffer
// comparison. A blank configured secret is a rejection, not an open door.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../lib/env.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { PayoutProviderConfigError } from './provider.interface.js';
import { PayoutError, type PayoutsService } from './payouts.service.js';
import {
  payoutEmailSchema,
  payoutIdParamsSchema,
  payoutListQuerySchema,
} from './payouts.schema.js';

export interface PayoutRoutesOptions extends FastifyPluginOptions {
  service: PayoutsService;
}

const CRON_SECRET_HEADER = 'x-payout-cron-secret';

/** Constant-time compare that tolerates differing lengths without throwing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PayoutError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err instanceof PayoutProviderConfigError) {
    // A misconfigured provider is our fault, not the caller's — and the message
    // names an env var, so it must not reach the client.
    return reply.code(503).send({ error: 'Payouts are not available' });
  }
  throw err;
}

export default async function payoutRoutes(
  app: FastifyInstance,
  opts: PayoutRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // Keep the raw bytes for IPN signature verification. Encapsulated to this
  // plugin, exactly like the payments plugin's parser — Fastify scopes content
  // type parsers per plugin, so no other module's JSON handling changes.
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

  // ── GET /balance ──────────────────────────────────────────────────────────
  // The model id comes from the verified JWT, never a path or query parameter,
  // so there is no other model's balance to ask for.
  app.get(
    '/balance',
    {
      preHandler: [authenticate, authorize('model')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const balance = await service.getBalance(request.user.userId);
      return reply.code(200).send(balance);
    },
  );

  // ── PUT /payout-email ─────────────────────────────────────────────────────
  // Where this model's earnings are sent. Self-service only: the userId comes
  // from the verified JWT, so a model can write their own destination and
  // nobody else's — there is no id in the body or path to substitute. Capped
  // low because changing a payout destination is not a high-frequency action,
  // and a burst of attempts is worth slowing down.
  app.put(
    '/payout-email',
    {
      preHandler: [authenticate, authorize('model')],
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const parsed = payoutEmailSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.setPayoutEmail(request.user.userId, parsed.data.payoutEmail);
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── POST /run ─────────────────────────────────────────────────────────────
  // Cron-only doesn't mean unguarded: a leaked secret must not be able to
  // trigger unlimited runs, so this is capped at 2/hour by IP on top of the
  // secret check.
  app.post(
    '/run',
    {
      config: { rateLimit: { max: 2, timeWindow: '1 hour' } },
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const provided = request.headers[CRON_SECRET_HEADER];
        const expected = env.PAYOUT_CRON_SECRET;
        // An unconfigured secret leaves the endpoint closed, never open.
        if (typeof provided !== 'string' || !expected || !secretMatches(provided, expected)) {
          await reply.code(401).send({ error: 'Unauthorized' });
        }
      },
    },
    async (_request, reply) => {
      try {
        const summary = await service.runPayouts();
        return reply.code(200).send(summary);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── POST /paxum/webhook ───────────────────────────────────────────────────
  // No auth — authenticity comes from the signature, which is checked before
  // any database access. Rate limited by IP as a cheap flood guard.
  app.post(
    '/paxum/webhook',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const rawBody = request.rawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: 'Missing request body' });
      }
      try {
        const outcome = await service.handleWebhook(rawBody, request.headers);
        return reply.code(200).send({
          received: true,
          processed: outcome.processed,
          duplicate: outcome.duplicate,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── GET / (ADMIN) ─────────────────────────────────────────────────────────
  // Minimal operational visibility until Session 11 owns the dashboard.
  app.get(
    '/',
    {
      preHandler: [authenticate, authorize('admin')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = payoutListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid query', details: parsed.error.flatten() });
      }
      const result = await service.listPayouts(parsed.data.limit, parsed.data.offset);
      return reply.code(200).send(result);
    },
  );

  // ── GET /:payoutId (ADMIN or the owning MODEL) ────────────────────────────
  app.get(
    '/:payoutId',
    {
      preHandler: [authenticate, authorize('admin', 'model')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = payoutIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const detail = await service.getPayoutDetail(parsed.data.payoutId, {
          userId: request.user.userId,
          role: request.user.role,
        });
        return reply.code(200).send(detail);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
