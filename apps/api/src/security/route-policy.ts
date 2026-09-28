// =============================================================================
// Route security policy (Session 12, D3).
//
// The default for every route is: `authenticate` runs, and a rate limit
// applies. These two lists are the only exceptions, each with the reason it is
// correct. `route-inventory.test.ts` fails if a route is outside the default
// and not listed here, and also if an entry here no longer describes a real
// route (or describes one that has since gained the control) — so the lists
// cannot silently go stale.
//
// Keys are `METHOD /full/url` exactly as Fastify registers them.
// =============================================================================

/** Routes intentionally reachable without the access-token `authenticate` hook. */
export const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  'GET /health': 'liveness probe — static JSON, no user data, no DB access',
  'POST /api/auth/register': 'account creation — there is no session yet',
  'GET /api/auth/verify-email': 'authenticated by the one-time 256-bit email token',
  'POST /api/auth/login': 'mints the session — authenticated by the password',
  'POST /api/auth/refresh': 'authenticated by the refresh-token cookie (verified + hash-checked)',
  'GET /api/content/model/:modelId':
    'public catalogue — optional auth; anonymous callers see FREE items only',
  'POST /api/payments/woovi/webhook': 'webhook — authenticated by HMAC signature over the raw body',
  'POST /api/payments/nowpayments/webhook':
    'webhook — authenticated by HMAC signature over the raw body',
  'POST /api/payouts/paxum/webhook': 'webhook — authenticated by HMAC signature over the raw body',
  'POST /api/payouts/run': 'cron — authenticated by X-Payout-Cron-Secret (timing-safe)',
  'POST /api/subscriptions/renewals/run':
    'cron — authenticated by X-Renewal-Cron-Secret (timing-safe)',
  'POST /api/admin/storage/cleanup/run':
    'cron — authenticated by X-Storage-Cleanup-Cron-Secret (timing-safe)',
  'POST /api/admin/reconciliation/run':
    'cron — authenticated by X-Reconciliation-Cron-Secret (timing-safe)',
};

/** Routes intentionally without any rate limit. */
export const UNLIMITED_ROUTES: Readonly<Record<string, string>> = {
  'GET /health':
    'polled by load balancers/uptime monitors from a few IPs at high frequency; constant-time, no DB',
};
