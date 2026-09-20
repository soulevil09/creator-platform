// Locale helpers (Session 10). The `Accept-Language` parser is a D5 entry
// point: whatever it returns is fed to a Zod allowlist in each app, but it must
// never itself produce anything outside `SUPPORTED_LOCALES`.
import { describe, expect, it } from 'vitest';
import {
  CREDIT_PACKS,
  GENERATION_PRESETS,
  SUBSCRIPTION_PLANS,
  SUPPORTED_LOCALES,
  negotiateLocale,
  resolveLabel,
} from './index';

describe('negotiateLocale', () => {
  it('matches exactly, case-insensitively', () => {
    expect(negotiateLocale('pt-BR')).toBe('pt-BR');
    expect(negotiateLocale('PT-br')).toBe('pt-BR');
    expect(negotiateLocale('en')).toBe('en');
  });

  it('matches by primary subtag', () => {
    expect(negotiateLocale('pt')).toBe('pt-BR');
    expect(negotiateLocale('pt-PT')).toBe('pt-BR');
    expect(negotiateLocale('en-GB')).toBe('en');
    expect(negotiateLocale('en-US,en;q=0.9')).toBe('en');
  });

  it('honours q-weights, with header order as the tiebreak', () => {
    expect(negotiateLocale('fr-FR,fr;q=0.9,en-GB;q=0.8,pt;q=0.7')).toBe('en');
    expect(negotiateLocale('en;q=0.5,pt-BR;q=0.9')).toBe('pt-BR');
    expect(negotiateLocale('en;q=0.5,pt-BR;q=0.5')).toBe('en');
    expect(negotiateLocale('en;q=0,pt-BR;q=0.1')).toBe('pt-BR');
  });

  it('returns undefined when nothing is supported, for a wildcard, or for garbage', () => {
    expect(negotiateLocale('de-DE,de;q=0.9')).toBeUndefined();
    expect(negotiateLocale('*')).toBeUndefined();
    expect(negotiateLocale('')).toBeUndefined();
    expect(negotiateLocale(undefined)).toBeUndefined();
    expect(negotiateLocale(null)).toBeUndefined();
    expect(negotiateLocale(';;;,,,q=')).toBeUndefined();
    expect(negotiateLocale('../../etc/passwd')).toBeUndefined();
  });

  it('only ever returns a member of the allowlist', () => {
    const inputs = ['pt', 'en-AU', 'pt-BR;q=0.2, en;q=0.3', 'zh, pt', 'xx-YY'];
    for (const input of inputs) {
      const out = negotiateLocale(input);
      expect(out === undefined || (SUPPORTED_LOCALES as readonly string[]).includes(out)).toBe(
        true,
      );
    }
  });
});

describe('localized catalogs', () => {
  it('every catalog label has an entry for every supported locale', () => {
    const labels = [
      ...Object.values(SUBSCRIPTION_PLANS).map((plan) => plan.label),
      ...CREDIT_PACKS.map((pack) => pack.label),
      ...GENERATION_PRESETS.map((preset) => preset.label),
    ];
    for (const label of labels) {
      for (const locale of SUPPORTED_LOCALES) {
        expect(resolveLabel(label, locale)).toEqual(expect.any(String));
        expect(resolveLabel(label, locale).length).toBeGreaterThan(0);
      }
    }
  });
});
