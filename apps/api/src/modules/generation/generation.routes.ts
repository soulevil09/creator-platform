// HTTP layer for AI image personalization. Owns input validation, RBAC, rate
// limits and response shaping; delegates every read and write to the
// generation service.
//
// Security invariants enforced here: `storageKey` is never read into a
// response (the service returns only signed URLs or watermarked bytes, passed
// through verbatim), and the subscriber is always the verified JWT's `userId`
// — no endpoint accepts one.
//
// Error bodies carry a machine-readable code (`prompt_rejected`,
// `ai_not_enabled`, `insufficient_credits`, …) in the existing `{ error }`
// shape: a client has to branch on these, and "buy credits" is a different
// screen from "this model has not enabled AI".
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { authenticate, authorize } from '../../middleware/auth.js';
import { GenerationError, type GenerationService } from './generation.service.js';
import {
  createGenerationSchema,
  generationIdParamsSchema,
  generationListQuerySchema,
} from './generation.schema.js';

export interface GenerationRoutesOptions extends FastifyPluginOptions {
  service: GenerationService;
}

/**
 * 10 generations per hour per subscriber, keyed on the JWT `userId` rather
 * than the IP (Session 05/07 precedent: NAT neighbours must not share a
 * budget, and one account must not earn a fresh one per IP). Attached via
 * `app.rateLimit()` AFTER `authenticate` (Session 11.5): the `config.rateLimit`
 * form runs at `onRequest`, before `request.user` is set, so it silently keyed
 * on the IP.
 *
 * Why 10: each call debits at least 10 credits and holds a connection open
 * for up to `GENERATION_TIMEOUT_MS` (90 s). Ten an hour caps one account at
 * ≤15 minutes of provider time per hour — comfortably above honest use (pick
 * a preset, wait, maybe re-roll a couple of times) and well below what would
 * make one account a cost or connection problem. It is a second bound on top
 * of the one-in-flight rule, which limits *concurrency* rather than *rate*;
 * both are needed because a client that serialises its requests would
 * otherwise never trip the concurrency guard.
 */
const CREATE_RATE_LIMIT = {
  max: 10,
  timeWindow: '1 hour',
  keyGenerator: (request: { user?: { userId?: string }; ip: string }) =>
    request.user?.userId ?? request.ip,
};

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof GenerationError) {
    return reply.code(err.status).send({ error: err.message });
  }
  throw err;
}

const subscriberOnly = { preHandler: [authenticate, authorize('subscriber')] };

export default async function generationRoutes(
  app: FastifyInstance,
  opts: GenerationRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── GET /presets ──────────────────────────────────────────────────────────
  // `authenticate` (any role) rather than public. The catalog holds no secret,
  // but it is a purchasing surface for logged-in users and nothing anonymous
  // needs it; keeping it behind the cookie costs a legitimate client nothing
  // and gives an unauthenticated scraper nothing — the same posture as
  // GET /api/wallet/balance. Loosen to public if a marketing page ever needs it.
  app.get('/presets', { preHandler: [authenticate] }, async (_request, reply) => {
    return reply.code(200).send({ presets: service.listPresets() });
  });

  // ── POST / ────────────────────────────────────────────────────────────────
  app.post(
    '/',
    { preHandler: [...subscriberOnly.preHandler, app.rateLimit(CREATE_RATE_LIMIT)] },
    async (request, reply) => {
      const parsed = createGenerationSchema.safeParse(request.body);
      if (!parsed.success) {
        // `flatten()` reports rule violations only, never the submitted value —
        // a prompt must not travel back out through an error payload.
        return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.create(request.user.userId, parsed.data);
        return reply.code(201).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── GET / ─────────────────────────────────────────────────────────────────
  app.get('/', subscriberOnly, async (request, reply) => {
    const query = generationListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', details: query.error.flatten() });
    }
    const result = await service.list(request.user.userId, query.data);
    return reply.code(200).send(result);
  });

  // ── GET /:id ──────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', subscriberOnly, async (request, reply) => {
    const params = generationIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_input', details: params.error.flatten() });
    }
    try {
      const result = await service.get(request.user.userId, params.data.id);
      return reply.code(200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── GET /:id/image ────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/image', subscriberOnly, async (request, reply) => {
    const params = generationIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_input', details: params.error.flatten() });
    }
    try {
      const result = await service.serveImage(request.user.userId, params.data.id);
      // Per-user watermarked bytes must never be cached.
      return reply
        .code(200)
        .header('Content-Type', result.mimeType)
        .header('Content-Disposition', 'inline')
        .header('Cache-Control', 'no-store')
        .send(result.buffer);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
