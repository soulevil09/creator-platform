'use client';

// Minimal EN / PT-BR switcher (Session 10, D2).
//
// Cookie-only routing: choosing a language writes the `NEXT_LOCALE` cookie and
// asks the router to re-render the current URL. The server reads the cookie
// ahead of `Accept-Language` on that next render, so the new language takes
// effect on the very next navigation with no restart and no URL change.
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LOCALE_COOKIE_NAME, SUPPORTED_LOCALES, type Locale } from '@creator-platform/shared';

/** One year — the choice is a preference, not a session. */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Catalog key per locale — dashes are not valid in message keys. */
const NAME_KEY: Record<Locale, 'en' | 'ptBR'> = { en: 'en', 'pt-BR': 'ptBR' };

const styles = {
  nav: {
    position: 'fixed',
    top: '0.75rem',
    right: '0.75rem',
    zIndex: 10,
    display: 'flex',
    gap: '0.25rem',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    fontSize: '0.8rem',
  },
  button: {
    padding: '0.3rem 0.6rem',
    borderRadius: 9999,
    border: '1px solid #334155',
    background: 'rgba(15, 23, 42, 0.7)',
    color: '#cbd5e1',
    cursor: 'pointer',
  },
  active: {
    borderColor: '#38bdf8',
    color: '#f8fafc',
  },
} as const;

export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations('localeSwitcher');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: Locale) {
    if (next === locale) return;
    // `next` is a member of SUPPORTED_LOCALES by type — the only values this
    // component can ever write. The server re-validates on read regardless.
    document.cookie = `${LOCALE_COOKIE_NAME}=${next}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <nav aria-label={t('label')} style={styles.nav}>
      {SUPPORTED_LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          aria-pressed={option === locale}
          disabled={pending}
          onClick={() => choose(option)}
          style={{ ...styles.button, ...(option === locale ? styles.active : {}) }}
        >
          {t(NAME_KEY[option])}
        </button>
      ))}
    </nav>
  );
}

export default LocaleSwitcher;
