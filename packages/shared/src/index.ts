/**
 * @creator-platform/shared
 *
 * Single source of truth for constants and types used by BOTH the web frontend
 * and the API backend. Keep this package framework-free (no React, no Fastify,
 * no Prisma) so either side can import it without pulling in runtime deps.
 */

// ─── Currencies ──────────────────────────────────────────────────────────────
/** Currencies the platform settles in. Must stay in sync with Stripe config. */
export const SUPPORTED_CURRENCIES = ['USD', 'BRL', 'EUR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

// ─── Locales ─────────────────────────────────────────────────────────────────
/** Base languages shipped at MVP; the app is i18n-ready for more. */
export const SUPPORTED_LOCALES = ['pt-BR', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'pt-BR';

// ─── Roles ───────────────────────────────────────────────────────────────────
/** Account roles used by RBAC (wired up in Session 02). */
export const USER_ROLES = ['model', 'subscriber', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

// ─── App metadata ────────────────────────────────────────────────────────────
export const APP_NAME = 'Creator Platform';

// ─── Guards / helpers ────────────────────────────────────────────────────────
export function isCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
