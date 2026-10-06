// Next.js server instrumentation hook (Session 13, D3). Sentry initialises
// only when NEXT_PUBLIC_SENTRY_DSN was set at build time; otherwise this is a
// no-op and `onRequestError` has no client to report to.
import * as Sentry from '@sentry/nextjs';
import { SENTRY_DSN, sentryOptions } from './sentry.shared';

export async function register(): Promise<void> {
  if (!SENTRY_DSN) return;
  // Next 16 runs both the server and the proxy on the Node.js runtime.
  if (process.env.NEXT_RUNTIME === 'nodejs') Sentry.init(sentryOptions);
}

/** Server errors in route handlers, server components and actions (5xx by nature). */
export const onRequestError = Sentry.captureRequestError;
