// Options common to every Sentry runtime in the web app (Session 13, D3).
// Inert unless a DSN is configured; scrubbed by the shared scrubber; tracing
// off unless NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE says otherwise.
import {
  SENTRY_DATA_COLLECTION,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '@creator-platform/shared';

/** Public by definition: a DSN only lets you SEND events to our project. */
export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || '';

function sampleRate(raw: string | undefined): number {
  const value = Number(raw ?? '0');
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

export const sentryOptions = {
  dsn: SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
  dataCollection: SENTRY_DATA_COLLECTION,
  tracesSampleRate: sampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE),
  beforeSend: <T extends object>(event: T) => scrubSentryEvent(event),
  beforeSendTransaction: <T extends object>(event: T) => scrubSentryEvent(event),
  beforeBreadcrumb: <T extends object>(breadcrumb: T) => scrubSentryBreadcrumb(breadcrumb),
};
