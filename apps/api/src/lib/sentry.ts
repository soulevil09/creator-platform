// =============================================================================
// Sentry for the API (Session 13, D3).
//
// Inert unless SENTRY_DSN is set: tests and local development never initialise
// the SDK, so nothing is sent and no network is touched. When enabled:
//
//   * `dataCollection` (Sentry 11's replacement for `sendDefaultPii`) set to
//     collect no user info, cookies, bodies, query params or DB data, and every event, transaction and breadcrumb
//     passes through the shared scrubber (@creator-platform/shared) — bodies,
//     cookies, auth/signature/cron headers, query strings, emails and any
//     password/secret/token/key/prompt/payoutEmail value are removed.
//   * Only server faults are reported: the Fastify integration (which listens
//     on Fastify 5's own diagnostics channel, so no preload is needed) captures
//     an error only when the reply is a 5xx. A 4xx is the client's problem and
//     is never sent. Unhandled rejections/exceptions are captured by the SDK's
//     default integrations.
//   * Tracing is off by default (`SENTRY_TRACES_SAMPLE_RATE=0`).
// =============================================================================
import * as Sentry from '@sentry/node';
import {
  SENTRY_DATA_COLLECTION,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '@creator-platform/shared';
import type { Env } from './env.js';

type SentryConfig = Pick<
  Env,
  'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'SENTRY_RELEASE' | 'SENTRY_TRACES_SAMPLE_RATE'
>;

/** The status a failed request is answered with; an unset 200 means "unhandled" → 500. */
export function replyStatus(error: unknown, replyStatusCode: number): number {
  if (replyStatusCode !== 200) return replyStatusCode;
  const own =
    typeof error === 'object' && error !== null
      ? Number(
          (error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status,
        )
      : NaN;
  return Number.isInteger(own) && own >= 400 ? own : 500;
}

/** 5xx only — the one rule for what is worth an alert. */
export function shouldReport(error: unknown, replyStatusCode: number): boolean {
  return replyStatus(error, replyStatusCode) >= 500;
}

/**
 * Initialise Sentry if a DSN is configured. Returns whether it did. `transport`
 * is a test seam (an in-memory transport); production uses the SDK default.
 */
export function initSentry(
  config: SentryConfig,
  overrides: Pick<Sentry.NodeOptions, 'transport'> = {},
): boolean {
  if (!config.SENTRY_DSN) return false;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    release: config.SENTRY_RELEASE || undefined,
    // The `sendDefaultPii: false` posture, in Sentry 11's vocabulary (and tighter).
    dataCollection: SENTRY_DATA_COLLECTION,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    integrations: [
      Sentry.fastifyIntegration({
        shouldHandleError: (error, _request, reply) => shouldReport(error, reply.statusCode),
      }),
    ],
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
    ...overrides,
  });
  return true;
}

/** Flush queued events before the process exits (bounded). */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (Sentry.isInitialized()) await Sentry.flush(timeoutMs);
}
