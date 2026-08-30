// HTTP layer for the credit wallet. One read endpoint at MVP: a caller can see
// their own balance and nothing else — the userId comes from the verified JWT,
// never from the path or query, so there is no object to enumerate.
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { WalletBalanceResponse } from '@creator-platform/shared';
import { authenticate } from '../../middleware/auth.js';
import type { WalletService } from './wallet.service.js';

export interface WalletRoutesOptions extends FastifyPluginOptions {
  service: WalletService;
}

export default async function walletRoutes(
  app: FastifyInstance,
  opts: WalletRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── GET /balance ──────────────────────────────────────────────────────────
  app.get(
    '/balance',
    { preHandler: [authenticate], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = request.user.userId;
      const balance = await service.getBalance(userId);
      const body: WalletBalanceResponse = { userId, balance };
      return reply.code(200).send(body);
    },
  );
}
