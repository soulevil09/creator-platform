// RBAC middleware: Fastify preHandler hooks.
//
//   authenticate          — verifies the access-token cookie and populates
//                           `request.user = { userId, role }` (via @fastify/jwt).
//   authorize(...roles)   — gate that 403s unless `request.user.role` is allowed.
//                           Always chain it AFTER `authenticate`.
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Role } from '@creator-platform/shared';

/**
 * Verify the `access_token` httpOnly cookie. On success @fastify/jwt sets
 * `request.user` to the decoded payload; on failure we answer 401 and stop the
 * request before the route handler runs.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.accessJwtVerify();
  } catch {
    await reply.code(401).send({ error: 'Unauthorized' });
  }
}

/**
 * Restrict a route to the given roles. Requires `authenticate` to have run, so
 * that `request.user` is set. Returns a fresh preHandler each call.
 */
export function authorize(...roles: Role[]): preHandlerHookHandler {
  return async function authorizeHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const role = request.user?.role;
    if (!role || !roles.includes(role)) {
      await reply.code(403).send({ error: 'Forbidden' });
    }
  };
}
