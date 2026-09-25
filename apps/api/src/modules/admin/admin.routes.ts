// HTTP layer for the admin console (Session 11).
//
// Every route here is `authenticate` + `authorize('admin')` — the exact hook
// pair Session 06 put on `GET /api/payouts` — applied once at plugin scope so
// no individual route can be registered without it. The web dashboard's
// client-side redirect is a convenience; these hooks are the security
// boundary.
//
// Rate limits are attached as route-level `preHandler`s via `app.rateLimit()`
// rather than `config.rateLimit`: the config form runs at `onRequest`, before
// `authenticate` has verified the cookie, so a userId-keyed generator there
// would only ever see the IP. A route-level preHandler runs after the
// plugin-scoped auth hooks, so these budgets are genuinely per admin — and an
// anonymous or non-admin caller is refused (401/403) before consuming any of
// an admin's budget.
//
// Payout listing/detail are NOT duplicated here: the dashboard consumes the
// existing `GET /api/payouts` and `GET /api/payouts/:payoutId` as-is.
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, authorize } from '../../middleware/auth.js';
import { ContentError } from '../content/content.service.js';
import { PayoutProviderConfigError } from '../payouts/provider.interface.js';
import { AdminError, type AdminService } from './admin.service.js';
import {
  modelListQuerySchema,
  rejectModelSchema,
  reportIdParamsSchema,
  reportListQuerySchema,
  resolveReportSchema,
  suspendUserSchema,
  userIdParamsSchema,
  userListQuerySchema,
} from './admin.schema.js';

export interface AdminRoutesOptions extends FastifyPluginOptions {
  service: AdminService;
}

const byUser = (request: FastifyRequest) => request.user?.userId ?? request.ip;

const READ_RATE_LIMIT = { max: 120, timeWindow: '1 minute', keyGenerator: byUser };
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 hour', keyGenerator: byUser };
/** Same ceiling as the cron entrance (2/hour) — a run is not a button to mash. */
const PAYOUT_RUN_RATE_LIMIT = { max: 2, timeWindow: '1 hour', keyGenerator: byUser };

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AdminError || err instanceof ContentError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err instanceof PayoutProviderConfigError) {
    // Our misconfiguration, not the caller's — and the message names an env
    // var, so it must not reach the client (same as the payouts routes).
    return reply.code(503).send({ error: 'Payouts are not available' });
  }
  throw err;
}

function invalid(reply: FastifyReply, error: { flatten(): unknown }): FastifyReply {
  return reply.code(400).send({ error: 'Invalid input', details: error.flatten() });
}

export default async function adminRoutes(
  app: FastifyInstance,
  opts: AdminRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // Plugin-scoped: applies to every route registered below, so there is no
  // way to add an admin endpoint here that forgets the check. Route-level
  // preHandlers (the rate limits) run after these.
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', authorize('admin'));

  const read = { preHandler: app.rateLimit(READ_RATE_LIMIT) };
  const write = { preHandler: app.rateLimit(WRITE_RATE_LIMIT) };
  const payoutRun = { preHandler: app.rateLimit(PAYOUT_RUN_RATE_LIMIT) };

  // ── D1 — model approval ───────────────────────────────────────────────────
  app.get('/models', read, async (request, reply) => {
    const parsed = modelListQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    return reply.code(200).send(await service.listModels(parsed.data));
  });

  app.post('/models/:userId/approve', write, async (request, reply) => {
    const params = userIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    try {
      const result = await service.approveModel(request.user.userId, params.data.userId);
      return reply.code(200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/models/:userId/reject', write, async (request, reply) => {
    const params = userIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const body = rejectModelSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      const result = await service.rejectModel(
        request.user.userId,
        params.data.userId,
        body.data.reason,
      );
      return reply.code(200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── D2 — user management ──────────────────────────────────────────────────
  app.get('/users', read, async (request, reply) => {
    const parsed = userListQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    return reply.code(200).send(await service.listUsers(parsed.data));
  });

  app.get('/users/:userId', read, async (request, reply) => {
    const params = userIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    try {
      return reply.code(200).send(await service.getUser(params.data.userId));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/users/:userId/suspend', write, async (request, reply) => {
    const params = userIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const body = suspendUserSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    try {
      const result = await service.suspendUser(
        request.user.userId,
        params.data.userId,
        body.data.reason,
      );
      return reply.code(200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/users/:userId/reinstate', write, async (request, reply) => {
    const params = userIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    try {
      const result = await service.reinstateUser(request.user.userId, params.data.userId);
      return reply.code(200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── D3 — metrics ──────────────────────────────────────────────────────────
  app.get('/metrics/overview', read, async (_request, reply) =>
    reply.code(200).send(await service.getMetricsOverview()),
  );

  // ── D4 — on-demand payout run ─────────────────────────────────────────────
  app.post('/payouts/run', payoutRun, async (request, reply) => {
    try {
      return reply.code(200).send(await service.runPayouts(request.user.userId));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── D5 — content moderation ───────────────────────────────────────────────
  app.get('/reports', read, async (request, reply) => {
    const parsed = reportListQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    return reply.code(200).send(await service.listReports(parsed.data));
  });

  app.post('/reports/:reportId/resolve', write, async (request, reply) => {
    const params = reportIdParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const body = resolveReportSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    try {
      const result = await service.resolveReport(
        request.user.userId,
        params.data.reportId,
        body.data.action,
      );
      return reply.code(200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
