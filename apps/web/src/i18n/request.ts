// next-intl request configuration (Session 10).
//
// Runs once per server request, in the App Router's request scope, before any
// server component renders. Reading `cookies()` / `headers()` here is what
// makes the very first HTML payload already in the right language — there is
// no client-side detection and therefore no flash of the wrong locale.
//
// Cookie-only routing, no `/en/` prefix: see `resolveLocale` and the Session
// 10 notes in CLAUDE.md for why.
import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE_NAME } from '@creator-platform/shared';
import { loadMessages, resolveLocale } from './locale';

export default getRequestConfig(async () => {
  const locale = resolveLocale({
    cookie: (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: (await headers()).get('accept-language'),
  });
  return { locale, messages: await loadMessages(locale) };
});
