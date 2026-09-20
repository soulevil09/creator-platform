// @vitest-environment node
// Locale resolution (Session 10, D2 + D5): cookie → Accept-Language → default,
// each step allowlisted, nothing reflected.
import { afterEach, describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '@creator-platform/shared';
import en from '../../messages/en.json';
import ptBR from '../../messages/pt-BR.json';
import { defaultLocale, loadMessages, resolveLocale, toLocale } from './locale';

const ENV = process.env.NEXT_PUBLIC_DEFAULT_LOCALE;
afterEach(() => {
  if (ENV === undefined) delete process.env.NEXT_PUBLIC_DEFAULT_LOCALE;
  else process.env.NEXT_PUBLIC_DEFAULT_LOCALE = ENV;
});

describe('toLocale', () => {
  it('accepts exactly the allowlist and nothing else', () => {
    for (const locale of SUPPORTED_LOCALES) expect(toLocale(locale)).toBe(locale);
    for (const bad of ['EN', 'pt', 'pt-br', 'fr', '', ' en', '../en', null, undefined]) {
      expect(toLocale(bad)).toBeUndefined();
    }
  });
});

describe('resolveLocale', () => {
  it('1. a valid cookie wins over the header', () => {
    expect(resolveLocale({ cookie: 'en', acceptLanguage: 'pt-BR' })).toBe('en');
    expect(resolveLocale({ cookie: 'pt-BR', acceptLanguage: 'en' })).toBe('pt-BR');
  });

  it('2. Accept-Language when there is no (valid) cookie', () => {
    expect(resolveLocale({ cookie: undefined, acceptLanguage: 'en-US,en;q=0.9' })).toBe('en');
    expect(resolveLocale({ cookie: '../../etc', acceptLanguage: 'pt' })).toBe('pt-BR');
  });

  it('3. NEXT_PUBLIC_DEFAULT_LOCALE as the final fallback — itself validated', () => {
    process.env.NEXT_PUBLIC_DEFAULT_LOCALE = 'en';
    expect(defaultLocale()).toBe('en');
    expect(resolveLocale({ cookie: undefined, acceptLanguage: 'de' })).toBe('en');

    process.env.NEXT_PUBLIC_DEFAULT_LOCALE = 'klingon';
    expect(defaultLocale()).toBe('pt-BR');
    expect(resolveLocale({ cookie: 'x', acceptLanguage: undefined })).toBe('pt-BR');
  });
});

describe('loadMessages', () => {
  it('loads exactly the requested catalog', async () => {
    expect(await loadMessages('en')).toEqual(en);
    expect(await loadMessages('pt-BR')).toEqual(ptBR);
  });
});
