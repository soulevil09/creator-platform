// Request validation schemas (Zod).
//
// Deviation note: the session guidance offered either a Zod-to-JSON-schema
// bridge or manual validation. We validate manually with Zod's `safeParse`
// inside each handler — it keeps the parsed type inference at the call site and
// avoids an extra schema-conversion dependency for a handful of endpoints.
import { z } from 'zod';
import { SUPPORTED_LOCALES } from '@creator-platform/shared';

/**
 * The one locale allowlist (Session 10, D5). Every entry point that accepts a
 * locale — registration, PATCH /me/locale, and the `Accept-Language` fallback —
 * validates through this schema before the value is persisted or used. It is
 * a hardcoded enum, never a DB enum, so a third language is a code change.
 */
export const localeSchema = z.enum(SUPPORTED_LOCALES);

// Public registration may only create `model` or `subscriber` accounts.
// `admin` is provisioned out-of-band and is rejected here with a 400.
//
// `locale` is optional and *lenient* on purpose: the spec says an invalid or
// missing value falls back to `Accept-Language`, then the default — a wrong
// language must not block a sign-up. `.catch(undefined)` turns an
// unrecognised value into "absent" so the route's fallback chain takes over.
// (PATCH /me/locale is the strict counterpart: there, a bad value is a 400.)
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(1, 'displayName is required').max(80),
  role: z.enum(['model', 'subscriber']),
  locale: localeSchema.optional().catch(undefined),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/** PATCH /me/locale — strict: reject anything off the allowlist, never coerce. */
export const updateLocaleSchema = z.object({
  locale: localeSchema,
});
export type UpdateLocaleInput = z.infer<typeof updateLocaleSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'token is required'),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
