// =============================================================================
// WebSocket delivery for private messaging.
//
// ── Why @fastify/websocket ──────────────────────────────────────────────────
// It runs `ws` inside the existing Fastify process, so real-time delivery costs
// no new hosted service, no per-message vendor pricing and no second identity
// system — the socket is authenticated by the same httpOnly access-token cookie
// the REST routes use, through the same `authenticate` hook, because the
// upgrade IS an HTTP request and Fastify runs its full lifecycle over it.
// A managed pub/sub (Pusher, Ably) would mean shipping our subscriber graph to
// a third party and paying per connection for something a single MVP instance
// serves for free; CLAUDE.md lists it as optional, not required. Socket.IO was
// the other candidate and is rejected for the opposite reason: it brings its
// own protocol, its own client library and its own reconnection/room semantics,
// where plain WebSocket over the existing cookie is the whole requirement.
//
// ── Authentication happens during the upgrade ───────────────────────────────
// `preValidation` runs before the handshake completes, so an unauthenticated
// upgrade is answered 401 and the socket is never established. The token comes
// from the httpOnly cookie and ONLY from there — never a query string, which
// would land the credential in every access log, proxy log and Referer header
// along the path.
//
// ── The socket is read-only ─────────────────────────────────────────────────
// Nothing a client sends over it is interpreted. Messages are created through
// `POST /api/messages/conversations/:id/messages` and nowhere else, so there is
// exactly one write path to validate, gate and rate-limit. Inbound frames are
// discarded rather than parsed: a channel that ignores input has no input
// handling to get wrong.
// =============================================================================
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import {
  CLOSE_TOO_MANY_CONNECTIONS,
  MAX_CONNECTIONS_PER_USER,
  type BroadcastSocket,
  type ConnectionRegistry,
} from './connections.js';

export interface MessagingWsOptions extends FastifyPluginOptions {
  connections: ConnectionRegistry;
}

export default async function messagingWsRoutes(
  app: FastifyInstance,
  opts: MessagingWsOptions,
): Promise<void> {
  const { connections } = opts;

  app.get(
    '/ws/messages',
    {
      websocket: true,
      // Runs before the handshake is completed: a request without a valid
      // access-token cookie gets 401 and no socket is ever opened.
      preValidation: [authenticate],
    },
    (socket, request) => {
      const { userId } = request.user;

      // An authenticated client can otherwise open sockets without limit — each
      // one a file descriptor and a registry entry that only they decide to
      // release. Over the cap the connection is accepted by the handshake and
      // immediately closed with a distinguishable code, so a client can tell
      // "too many tabs" from a network drop and stop retrying.
      if (!connections.add(userId, socket as unknown as BroadcastSocket)) {
        socket.close(
          CLOSE_TOO_MANY_CONNECTIONS,
          `At most ${MAX_CONNECTIONS_PER_USER} concurrent connections`,
        );
        return;
      }

      const drop = () => connections.remove(userId, socket as unknown as BroadcastSocket);
      socket.on('close', drop);
      // A socket that errors is gone whether or not 'close' follows; dropping it
      // twice is a no-op, leaving it registered is a leak.
      socket.on('error', drop);
      // Broadcast-only: inbound frames carry no meaning and are not parsed.
      socket.on('message', () => {});
    },
  );

  // Let `app.close()` finish: an open socket keeps the server listening.
  app.addHook('onClose', async () => {
    connections.closeAll();
  });
}
