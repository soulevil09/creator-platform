// =============================================================================
// Locale resolution for the web app (Session 10, D2 + D5).
//
// Resolution order, fixed by the spec:
//   1. the cookie the language switcher writes (`NEXT_LOCALE`)
//   2. the request's `Accept-Language` header
//   3. `NEXT_PUBLIC_DEFAULT_LOCALE` (itself validated; `DEFAULT_LOCALE` if unset
//      or unrecognised)
//
// Every candidate — cookie value, negotiated header value, env value — goes
// through the same Zod allowlist before it is used. A value that fails simply
// falls through to the next step; it is never reflected anywhere. The catalog
// loader below is keyed by the validated locale, and the import paths are
// spelled out literally: no string from a request ever forms an import path.
// =============================================================================
import { z } from 'zod';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  negotiateLocale,
  type Locale,
} from '@creator-platform/shared';
import type { AbstractIntlMessages } from 'next-intl';

/** The one allowlist. Same shape as the API's `localeSchema`. */
export const localeSchema = z.enum(SUPPORTED_LOCALES);

/** Narrow an untrusted string to a supported locale, or undefined. */
export function toLocale(value: string | null | undefined): Locale | undefined {
  const parsed = localeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The final fallback. Read at call time (not module load) so a test can set
 * the variable; validated like any other input so a typo in the deployment
 * env cannot select a catalog that does not exist.
 */
export function defaultLocale(): Locale {
  return toLocale(process.env.NEXT_PUBLIC_DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
}

export interface ResolveLocaleInput {
  /** Raw value of the `NEXT_LOCALE` cookie, if present. */
  cookie: string | null | undefined;
  /** Raw `Accept-Language` request header, if present. */
  acceptLanguage: string | null | undefined;
}

/** Cookie → Accept-Language → default, each step allowlisted. Pure. */
export function resolveLocale({ cookie, acceptLanguage }: ResolveLocaleInput): Locale {
  return toLocale(cookie) ?? toLocale(negotiateLocale(acceptLanguage)) ?? defaultLocale();
}

/**
 * Per-locale catalog loaders. One literal `import()` per locale means each
 * catalog is its own chunk and only the requested one is ever loaded — and
 * that the loaded path is chosen by a typed key, never assembled from a
 * request string. Adding a locale is a compile error here until its loader
 * exists.
 */
const CATALOGS: Record<Locale, () => Promise<AbstractIntlMessages>> = {
  en: () => import('../../messages/en.json').then((m) => m.default),
  'pt-BR': () => import('../../messages/pt-BR.json').then((m) => m.default),
};

export function loadMessages(locale: Locale): Promise<AbstractIntlMessages> {
  return CATALOGS[locale]();
}
