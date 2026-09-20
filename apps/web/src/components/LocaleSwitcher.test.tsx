// =============================================================================
// LocaleSwitcher tests (Session 10, D2).
//
// Cookie-only routing: choosing a language must (1) write the NEXT_LOCALE
// cookie and (2) ask the router to re-render — the server then picks the
// cookie up on that next render (proved end-to-end in src/i18n/ssr.test.ts).
// `next/navigation` is mocked: there is no App Router in jsdom.
// =============================================================================
import { NextIntlClientProvider } from 'next-intl';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_COOKIE_NAME } from '@creator-platform/shared';
import en from '../../messages/en.json';
import ptBR from '../../messages/pt-BR.json';
import { LocaleSwitcher } from './LocaleSwitcher';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

function clearCookie() {
  document.cookie = `${LOCALE_COOKIE_NAME}=; path=/; max-age=0`;
}

describe('LocaleSwitcher', () => {
  beforeEach(() => {
    refresh.mockClear();
    clearCookie();
  });
  afterEach(() => {
    cleanup();
    clearCookie();
  });

  it('writes the locale cookie and refreshes the route when another language is chosen', () => {
    render(
      <NextIntlClientProvider locale="pt-BR" messages={ptBR}>
        <LocaleSwitcher />
      </NextIntlClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: ptBR.localeSwitcher.label });
    expect(nav).toBeTruthy();
    const current = screen.getByRole('button', { name: ptBR.localeSwitcher.ptBR });
    expect(current.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: ptBR.localeSwitcher.en }));

    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for the language already active', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <LocaleSwitcher />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: en.localeSwitcher.en }));
    expect(document.cookie).not.toContain(LOCALE_COOKIE_NAME);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('labels itself from the active catalog', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <LocaleSwitcher />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('navigation', { name: en.localeSwitcher.label })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: ptBR.localeSwitcher.label })).toBeNull();
  });
});
