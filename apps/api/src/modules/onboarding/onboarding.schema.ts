// Request validation schemas (Zod) for the model onboarding module.
//
// Mirrors the auth module's manual `safeParse`-at-the-handler approach. All
// string inputs are trimmed here so the service never sees leading/trailing
// whitespace; `displayName` must be non-empty after trim.
import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '@creator-platform/shared';

export const profileSchema = z.object({
  displayName: z.string().trim().min(2, 'displayName must be at least 2 characters').max(60),
  // `.trim()` first, then treat an emptied string as "omitted" so a blank bio
  // is stored as undefined rather than "".
  bio: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  // ISO 3166-1 alpha-2, normalised to uppercase (e.g. "br" → "BR").
  country: z
    .string()
    .trim()
    .length(2, 'country must be a 2-letter ISO code')
    .regex(/^[A-Za-z]{2}$/, 'country must be two ASCII letters')
    .toUpperCase(),
  currency: z.enum(SUPPORTED_CURRENCIES),
  // Optional ToS acceptance flag; when true the service stamps tosAcceptedAt.
  tosAccepted: z.boolean().optional(),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export const consentSchema = z.object({
  aiConsent: z.boolean(),
});
export type ConsentInput = z.infer<typeof consentSchema>;
