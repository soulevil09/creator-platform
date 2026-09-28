// Type augmentation for our two namespaced @fastify/jwt registrations.
//
// @fastify/jwt only ships types for the default `jwtSign`/`jwtVerify` names.
// We register it twice (namespaces `access` and `refresh`) so each token type
// has its own secret + cookie, which produces dynamically-named decorators
// (`accessJwtVerify`, `refreshJwtSign`, …) that we declare here.
import '@fastify/jwt';
import type { FastifyJwtSignOptions, FastifyJwtVerifyOptions } from '@fastify/jwt';
import type { JwtPayload } from '@creator-platform/shared';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
  // A namespaced registration also hangs its signer/verifier off
  // `fastify.jwt[namespace]` — used by the Session 12 tests and load harness
  // to mint a token without a login round-trip.
  interface JWT {
    access: JWT;
    refresh: JWT;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    accessJwtVerify<T = JwtPayload>(options?: FastifyJwtVerifyOptions): Promise<T>;
    refreshJwtVerify<T = JwtPayload>(options?: FastifyJwtVerifyOptions): Promise<T>;
  }
  interface FastifyReply {
    accessJwtSign(payload: JwtPayload, options?: FastifyJwtSignOptions): Promise<string>;
    refreshJwtSign(payload: JwtPayload, options?: FastifyJwtSignOptions): Promise<string>;
  }
}
