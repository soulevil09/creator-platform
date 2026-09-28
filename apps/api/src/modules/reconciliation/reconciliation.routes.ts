// HTTP layer for the reconciliation sweep (Session 12, D6): one cron-triggered
// endpoint.
//
// Same guard as `POST /api/payouts/run`, `/api/subscriptions/renewals/run` and
// `/api/admin/storage/cleanup/run`: the caller is a GitHub Actions cron job
// with no user session, so a shared secret in a header authenticates the
// machine. It is compared with `crypto.timingSafeEqual` (length-checked first),
// checked before any database access, and a blank configured secret keeps the
// endpoint closed. `secretMatches` is a local copy, per the codebase's
// one-copy-per-cron-route pattern.
//
// 4/hour like the renewal and cleanup sweeps: it runs daily and may need a
// same-day retry, but a leaked secret still cannot trigger unlimited runs.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../lib/env.js';
import type { ReconciliationService } from './reconciliation.service.js';

export interface ReconciliationRoutesOptions extends FastifyPluginOptions {
  service: ReconciliationService;
}

const CRON_SECRET_HEADER = 'x-reconciliation-cron-secret';

/** Constant-time compare that tolerates differing lengths without throwing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default async function reconciliationRoutes(
  app: FastifyInstance,
  opts: ReconciliationRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── POST /run ─────────────────────────────────────────────────────────────
  app.post(
    '/run',
    {
      config: { rateLimit: { max: 4, timeWindow: '1 hour' } },
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const provided = request.headers[CRON_SECRET_HEADER];
        const expected = env.RECONCILIATION_CRON_SECRET;
        // An unconfigured secret leaves the endpoint closed, never open.
        if (typeof provided !== 'string' || !expected || !secretMatches(provided, expected)) {
          await reply.code(401).send({ error: 'Unauthorized' });
        }
      },
    },
    async (_request, reply) => {
      // Counts only — this body lands in a GitHub Actions step summary.
      const summary = await service.run();
      return reply.code(200).send(summary);
    },
  );
}
