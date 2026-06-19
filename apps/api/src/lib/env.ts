// =============================================================================
// Startup environment validation.
//
// Importing this module reads and validates the required secrets *eagerly*, so
// the process crashes at boot with a clear message if any are missing — never
// at the first request. This satisfies the Session 02 security requirement:
// "if JWT_SECRET, JWT_REFRESH_SECRET, or EMAIL_API_KEY are missing → throw and
// exit". No secret is ever logged.
// =============================================================================

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

  // Tunables with safe defaults.
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  EMAIL_FROM: process.env.EMAIL_FROM ?? 'noreply@example.com',
  APP_URL: process.env.APP_URL ?? 'http://localhost:3000',
} as const;

export type Env = typeof env;

// Cookie lifetimes in seconds, derived from the token TTLs above.
export const ACCESS_COOKIE_MAX_AGE = 15 * 60; // 15 minutes
export const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days
