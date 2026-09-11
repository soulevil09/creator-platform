// HTTP layer for the storage-hygiene sweep: one cron-triggered endpoint.
//
// ── Why /cleanup/run is guarded by a service secret, not a JWT ───────────────
// Identical reasoning to `POST /api/payouts/run` (Session 06) and
// `POST /api/subscriptions/renewals/run` (Session 06.5): the caller is a GitHub
// Actions cron job with no user session, so it has no JWT to present and no way
// to obtain one without holding a real password — and there is still no admin
// dashboard (Session 11). A shared secret in a header authenticates the
// *machine* honestly, is compared with `crypto.timingSafeEqual` rather than
// `===`, is checked before any database or storage access, and rotates in one
// GitHub secret.
//
// Rate limit is 4/hour like the renewal sweep: it runs daily and may need a
// same-day retry after a transient storage outage. A leaked secret still
// cannot trigger unlimited runs.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../lib/env.js';
import type { StorageCleanupService } from './storage-cleanup.service.js';

export interface StorageCleanupRoutesOptions extends FastifyPluginOptions {
  service: StorageCleanupService;
}

const CRON_SECRET_HEADER = 'x-storage-cleanup-cron-secret';

/** Constant-time compare that tolerates differing lengths without throwing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default async function storageCleanupRoutes(
  app: FastifyInstance,
  opts: StorageCleanupRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── POST /cleanup/run ─────────────────────────────────────────────────────
  app.post(
    '/cleanup/run',
    {
      config: { rateLimit: { max: 4, timeWindow: '1 hour' } },
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const provided = request.headers[CRON_SECRET_HEADER];
        const expected = env.STORAGE_CLEANUP_CRON_SECRET;
        // An unconfigured secret leaves the endpoint closed, never open.
        if (typeof provided !== 'string' || !expected || !secretMatches(provided, expected)) {
          await reply.code(401).send({ error: 'Unauthorized' });
        }
      },
    },
    async (_request, reply) => {
      // Counts only — no ids, no keys — the caller is a machine with a shared
      // secret, and this body lands in a GitHub Actions step summary.
      const summary = await service.run();
      return reply.code(200).send(summary);
    },
  );
}
