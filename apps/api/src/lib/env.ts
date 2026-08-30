// =============================================================================
// Startup environment validation.
//
// Importing this module reads and validates the required secrets *eagerly*, so
// the process crashes at boot with a clear message if any are missing — never
// at the first request. This satisfies the Session 02 security requirement:
// "if JWT_SECRET, JWT_REFRESH_SECRET, or EMAIL_API_KEY are missing → throw and
// exit". No secret is ever logged.
// =============================================================================

/**
 * Required in production, optional elsewhere. Used for third-party payment
 * credentials: a dev/test checkout runs against mocked HTTP, but a production
 * boot without them would fail silently at the first charge, so we crash early.
 */
function requiredInProduction(name: string, nodeEnv: string): string {
  const value = process.env[name] ?? '';
  if (nodeEnv === 'production' && value.trim() === '') {
    throw new Error(
      `[env] Missing required environment variable: ${name}. ` +
        `Set it in apps/api/.env (see apps/api/.env.example).`,
    );
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `[env] Missing required environment variable: ${name}. ` +
        `Set it in apps/api/.env (see apps/api/.env.example).`,
    );
  }
  return value;
}

const NODE_ENV = process.env.NODE_ENV ?? 'development';

export const env = {
  NODE_ENV,
  isProduction: NODE_ENV === 'production',

  // Secrets — validated eagerly (throw on boot if absent).
  JWT_SECRET: required('JWT_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  EMAIL_API_KEY: required('EMAIL_API_KEY'),

  // Object storage (Supabase Storage / S3-compatible) — Session 03.
  STORAGE_ENDPOINT: required('STORAGE_ENDPOINT'),
  STORAGE_BUCKET: required('STORAGE_BUCKET'),
  STORAGE_ACCESS_KEY: required('STORAGE_ACCESS_KEY'),
  STORAGE_SECRET_KEY: required('STORAGE_SECRET_KEY'),

  // ─── Payments (Session 05) ────────────────────────────────────────────────
  // `PAYMENT_PROVIDER_PIX` / `_CRYPTO` / `_CARD` pick the adapter per channel;
  // they are read (and validated) in modules/payments/provider.factory.ts,
  // which crashes at boot on an unknown value rather than falling back.
  //
  // Woovi (OpenPix) — PIX. Credentials are pending merchant approval, so they
  // are only hard-required in production.
  OPENPIX_APP_ID: requiredInProduction('OPENPIX_APP_ID', NODE_ENV),
  OPENPIX_WEBHOOK_SECRET: requiredInProduction('OPENPIX_WEBHOOK_SECRET', NODE_ENV),
  OPENPIX_API_URL: process.env.OPENPIX_API_URL ?? 'https://api.woovi.com',

  // NOWPayments — crypto.
  NOWPAYMENTS_API_KEY: requiredInProduction('NOWPAYMENTS_API_KEY', NODE_ENV),
  NOWPAYMENTS_IPN_SECRET: requiredInProduction('NOWPAYMENTS_IPN_SECRET', NODE_ENV),
  NOWPAYMENTS_API_URL: process.env.NOWPAYMENTS_API_URL ?? 'https://api.nowpayments.io',
  // Optional recurring-plan ids. When unset, a subscription checkout still
  // produces the first period's payment — only the provider-side recurrence
  // registration is skipped.
  NOWPAYMENTS_PLAN_ID_STANDARD: process.env.NOWPAYMENTS_PLAN_ID_STANDARD ?? '',
  NOWPAYMENTS_PLAN_ID_PREMIUM: process.env.NOWPAYMENTS_PLAN_ID_PREMIUM ?? '',

  /** Public base URL the providers call back to with webhooks. */
  API_PUBLIC_URL: process.env.API_PUBLIC_URL ?? 'http://localhost:4000',

  // Tunables with safe defaults.
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  EMAIL_FROM: process.env.EMAIL_FROM ?? 'noreply@example.com',
  APP_URL: process.env.APP_URL ?? 'http://localhost:3000',
  // S3 signing needs a region string even for region-less providers (Supabase
  // Storage / R2); the value only affects the SigV4 signature, not routing.
  STORAGE_REGION: process.env.STORAGE_REGION ?? 'us-east-1',
} as const;

export type Env = typeof env;

// Cookie lifetimes in seconds, derived from the token TTLs above.
export const ACCESS_COOKIE_MAX_AGE = 15 * 60; // 15 minutes
export const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days
