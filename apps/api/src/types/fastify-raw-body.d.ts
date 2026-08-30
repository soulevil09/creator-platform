// The payments plugin installs a JSON content-type parser that keeps the
// original bytes alongside the parsed body, because webhook signatures are
// computed over the raw request — re-serializing the parsed object changes key
// order and whitespace, and the digest with it.
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request bytes, populated only inside the payments plugin scope. */
    rawBody?: Buffer;
  }
}
