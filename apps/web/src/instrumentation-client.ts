// Browser Sentry (Session 13, D3). Events go to our own `/monitoring` tunnel,
// so the CSP `connect-src` stays 'self' + API — no Sentry host — and the
// tunnel forwards only to our project (src/security/sentry-tunnel.ts).
// Unhandled errors only: no replay, no tracing unless the sample rate is set.
import * as Sentry from '@sentry/nextjs';
import { SENTRY_DSN, sentryOptions } from './sentry.shared';

if (SENTRY_DSN) {
  Sentry.init({ ...sentryOptions, tunnel: '/monitoring' });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
