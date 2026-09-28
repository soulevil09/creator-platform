// =============================================================================
// API error surface (Session 12, D2).
//
// Routes already answer their own typed domain errors (`AuthError`,
// `PaymentError`, …) with `{ error: string }` bodies and rethrow anything they
// do not recognise. What reaches this handler is therefore either a Fastify /
// plugin error (parse failure, oversize body, rate limit) or a genuine bug —
// and a bug's message is exactly what must never reach a client: a Prisma
// error quotes SQL and column names, a provider error can quote a response
// body, and a stack names files.
//
//   5xx or no status → 500 `{ error: 'internal_error' }`, full error logged.
//   body too large   → 413 `{ error: 'payload_too_large' }`.
//   parse/validation → 400 `{ error: 'bad_request' }` (never echoes input).
//   any other 4xx    → Fastify's default serialisation, unchanged (429s etc).
//   unknown route    → 404 `{ error: 'not_found' }`.
// =============================================================================
import type { FastifyError, FastifyInstance } from 'fastify';

/** Fastify parse/validation failures whose default message can quote the input. */
const BAD_REQUEST_CODES = new Set([
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  'FST_ERR_CTP_INVALID_CONTENT_LENGTH',
  'FST_ERR_VALIDATION',
]);

type HandledError = FastifyError & { status?: number };

/**
 * The status Fastify's own default handler would pick: `statusCode`, then
 * `status` (the typed domain errors, e.g. `InsufficientCreditsError`, carry
 * `status`), then a status the route already set before throwing.
 */
function statusOf(error: HandledError, replyStatus: number): number | undefined {
  const status = error.statusCode ?? error.status;
  if (typeof status === 'number' && status >= 400) return status;
  return replyStatus >= 400 ? replyStatus : undefined;
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: HandledError, request, reply) => {
    const status = statusOf(error, reply.statusCode);

    if (status === undefined || status >= 500) {
      // The whole error — message, stack, cause — goes to the server log
      // only. Nothing about it is reflected in the response.
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error' });
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
      return reply.code(413).send({ error: 'payload_too_large' });
    }
    if (error.validation || (error.code && BAD_REQUEST_CODES.has(error.code))) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    // Any other 4xx (a rate-limit 429, an unsupported media type, …) keeps
    // exactly the body it had before this handler existed: sending the error
    // from inside a custom handler delegates to Fastify's default one.
    return reply.send(error);
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
}
