// =============================================================================
// Email template tests (Session 10, D3).
//
// The Resend client is never constructed here: `renderVerificationEmail` /
// `renderRenewalReminderEmail` are the pure template layer the emailer wraps,
// so the suite asserts on the exact subject/body each locale produces.
//
//   * both templates exist in full in PT-BR and EN
//   * amounts render through Intl — `R$ 29,90` vs `$29.99` for the SAME cents
//   * every interpolated value is HTML-escaped in BOTH locales
//   * an off-allowlist locale falls back to the default instead of indexing
//     the template map with an arbitrary string
// =============================================================================
import { describe, expect, it } from 'vitest';
import type { Locale } from '@creator-platform/shared';
import {
  formatAmount,
  renderRenewalReminderEmail,
  renderVerificationEmail,
  type RenewalReminderParams,
} from './email.js';

/** Intl uses U+00A0 between symbol and number; normalise for readable asserts. */
const nbsp = (s: string) => s.replace(/\u00a0/g, ' ');

const reminder = (overrides: Partial<RenewalReminderParams> = {}): RenewalReminderParams => ({
  modelName: 'Ana',
  tier: 'STANDARD',
  amountCents: 2990,
  currency: 'BRL',
  currentPeriodEnd: new Date('2026-10-15T12:00:00Z'),
  payment: {
    method: 'pix',
    qrCodeImage: 'https://qr.example/x.png',
    brCode: '00020126BR.GOV.BCB.PIX-COPIA-E-COLA',
    paymentLinkUrl: null,
  },
  ...overrides,
});

describe('formatAmount', () => {
  it('renders the same minor units per locale conventions', () => {
    expect(nbsp(formatAmount(2990, 'BRL', 'pt-BR'))).toBe('R$ 29,90');
    expect(nbsp(formatAmount(2999, 'USD', 'en'))).toBe('$29.99');
    expect(nbsp(formatAmount(2990, 'BRL', 'en'))).toBe('R$29.90');
    expect(nbsp(formatAmount(599, 'USD', 'pt-BR'))).toBe('US$ 5,99');
  });
});

describe('renderVerificationEmail', () => {
  it('produces the Portuguese template for pt-BR', () => {
    const { subject, html } = renderVerificationEmail('tok123', 'pt-BR');
    expect(subject).toBe('Confirme seu e-mail');
    expect(html).toContain('Confirme seu endereço de e-mail');
    expect(html).toContain('/verify-email?token=tok123');
  });

  it('produces the English template for en', () => {
    const { subject, html } = renderVerificationEmail('tok123', 'en');
    expect(subject).toBe('Verify your email');
    expect(html).toContain('Confirm your email address');
    expect(html).toContain('/verify-email?token=tok123');
  });

  it('URL-encodes the token so it cannot break out of the link', () => {
    const { html } = renderVerificationEmail('a b&c"<d>', 'en');
    expect(html).not.toContain('<d>');
    expect(html).toContain('a%20b%26c%22%3Cd%3E');
  });
});

describe('renderRenewalReminderEmail', () => {
  it('pt-BR: Portuguese subject/body with a comma-decimal amount and a localised date', () => {
    const { subject, html } = renderRenewalReminderEmail(reminder(), 'pt-BR');
    expect(subject).toBe('Sua assinatura de Ana renova em breve');
    expect(nbsp(html)).toContain('pague R$ 29,90');
    expect(html).toContain('15 de outubro de 2026');
    expect(html).toContain('Pague com PIX');
    expect(html).toContain('/subscriptions');
    expect(html).not.toMatch(/renews soon|To keep access/);
  });

  it('en: English subject/body with a dot-decimal amount', () => {
    const { subject, html } = renderRenewalReminderEmail(
      reminder({ amountCents: 599, currency: 'USD' }),
      'en',
    );
    expect(subject).toBe('Your Ana subscription renews soon');
    expect(nbsp(html)).toContain('pay $5.99');
    expect(html).toContain('October 15, 2026');
    expect(html).toContain('Pay with PIX');
    expect(html).not.toMatch(/renova em breve|manter o acesso/);
  });

  it.each(['pt-BR', 'en'] as const)('%s: escapes every interpolated value', (locale) => {
    const { subject, html } = renderRenewalReminderEmail(
      reminder({
        modelName: '<img src=x onerror=alert(1)>',
        payment: {
          method: 'crypto',
          payAddress: '"><script>1</script>',
          payAmount: '<b>0.01</b>',
          payCurrency: 'us&dt',
          payMemo: '<i>memo</i>',
        },
      }),
      locale,
    );
    for (const out of [subject, html]) {
      expect(out).not.toContain('<img');
      expect(out).not.toContain('<script>');
      expect(out).not.toContain('<b>');
      expect(out).not.toContain('<i>');
    }
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    expect(html).toContain('us&amp;dt');
  });

  it('falls back to the default (pt-BR) template for an off-allowlist locale', () => {
    const { subject } = renderRenewalReminderEmail(reminder(), 'xx-XX' as unknown as Locale);
    expect(subject).toBe('Sua assinatura de Ana renova em breve');
  });
});
