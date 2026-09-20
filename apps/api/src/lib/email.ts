// Transactional email via Resend (free tier; swappable behind this interface).
//
// The rest of the app depends only on the `Emailer` interface, so tests inject a
// fake and Session 13+ can swap providers without touching auth code.
//
// ── Localization (Session 10) ───────────────────────────────────────────────
// Both templates exist in every supported locale as a plain
// `Record<Locale, …>` map — the same small keyed-map shape as
// `CHANNEL_CURRENCY`, and deliberately not an i18n runtime: two templates do
// not justify a dependency. The caller passes the recipient's `preferredLocale`;
// anything outside the allowlist falls back to `DEFAULT_LOCALE` here rather
// than indexing the map with an unvalidated string. Every interpolated value in
// every locale goes through `escapeHtml` — no localized template may skip it.
import { Resend } from 'resend';
import {
  DEFAULT_LOCALE,
  isLocale,
  type ChargePayload,
  type Locale,
  type SubscriptionTier,
} from '@creator-platform/shared';
import { env } from './env.js';

/**
 * What a renewal reminder needs to say. The charge has already been issued by
 * the time this is called, so the email carries the actual payment instrument
 * (a PIX copia-e-cola string, or a crypto address and amount) rather than
 * asking the subscriber to go find it — the whole point of the reminder is that
 * PIX and crypto are one-shot instruments with no stored mandate to pull from.
 */
export interface RenewalReminderParams {
  modelName: string;
  tier: SubscriptionTier;
  /** Minor units (centavos/cents) — never a float. */
  amountCents: number;
  currency: string;
  /** When the current, already-paid-for period runs out. */
  currentPeriodEnd: Date;
  payment: ChargePayload;
}

export interface Emailer {
  sendVerificationEmail(to: string, verifyToken: string, locale: Locale): Promise<void>;
  sendRenewalReminderEmail(
    to: string,
    params: RenewalReminderParams,
    locale: Locale,
  ): Promise<void>;
}

function verificationUrl(token: string): string {
  return `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
}

/** Escape interpolated values so a display name can never inject markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minor units → a locale-formatted currency string: `R$ 29,90` in pt-BR,
 * `$29.99` in en. Integer input only; the division happens inside the
 * formatter's own decimal handling, never in a float we then print ourselves.
 */
export function formatAmount(amountCents: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountCents / 100);
}

/** A calendar date in the recipient's language; UTC so the day never shifts. */
function formatDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

/** Only the allowlisted locales index the template map; anything else defaults. */
function toLocale(locale: string): Locale {
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

interface EmailTemplates {
  verification: {
    subject: string;
    body(params: { url: string }): string;
  };
  renewalReminder: {
    subject(params: { model: string }): string;
    body(params: {
      model: string;
      tier: string;
      periodEnd: string;
      amount: string;
      instructions: string;
      manageUrl: string;
    }): string;
  };
  payment: {
    pix(params: { brCode: string }): string;
    crypto(params: {
      amount: string;
      currency: string;
      address: string;
      memo: string | null;
    }): string;
    fallback(params: { checkoutUrl: string }): string;
  };
}

// Every value handed to these templates is ALREADY escaped by the callers
// below (`escapeHtml` at the single point where a raw string enters), so the
// templates themselves only ever interpolate safe strings. Keep it that way:
// a template must never receive a raw display name, code or address.
const TEMPLATES: Record<Locale, EmailTemplates> = {
  en: {
    verification: {
      subject: 'Verify your email',
      body: ({ url }) => `<p>Welcome to Creator Platform.</p>
<p>Confirm your email address by clicking the link below (valid for 24 hours):</p>
<p><a href="${url}">${url}</a></p>`,
    },
    renewalReminder: {
      subject: ({ model }) => `Your ${model} subscription renews soon`,
      body: ({ model, tier, periodEnd, amount, instructions, manageUrl }) =>
        `<p>Your ${tier} subscription to ${model} ends on ${periodEnd}.</p>
<p>To keep access, pay ${amount}.</p>
${instructions}
<p>Don't want to renew? Cancel any time at <a href="${manageUrl}">${manageUrl}</a> — you keep everything you already paid for until the date above.</p>`,
    },
    payment: {
      pix: ({ brCode }) => `<p>Pay with PIX — copy and paste this code into your bank app:</p>
<p><code>${brCode}</code></p>`,
      crypto: ({ amount, currency, address, memo }) =>
        `<p>Send <strong>${amount} ${currency}</strong> to:</p>
<p><code>${address}</code></p>${memo ? `<p>Memo/tag: <code>${memo}</code></p>` : ''}`,
      fallback: ({ checkoutUrl }) => `<p><a href="${checkoutUrl}">Complete your payment</a></p>`,
    },
  },
  'pt-BR': {
    verification: {
      subject: 'Confirme seu e-mail',
      body: ({ url }) => `<p>Bem-vindo(a) à Creator Platform.</p>
<p>Confirme seu endereço de e-mail clicando no link abaixo (válido por 24 horas):</p>
<p><a href="${url}">${url}</a></p>`,
    },
    renewalReminder: {
      subject: ({ model }) => `Sua assinatura de ${model} renova em breve`,
      body: ({ model, tier, periodEnd, amount, instructions, manageUrl }) =>
        `<p>Sua assinatura ${tier} de ${model} termina em ${periodEnd}.</p>
<p>Para manter o acesso, pague ${amount}.</p>
${instructions}
<p>Não quer renovar? Cancele quando quiser em <a href="${manageUrl}">${manageUrl}</a> — você mantém tudo o que já pagou até a data acima.</p>`,
    },
    payment: {
      pix: ({ brCode }) => `<p>Pague com PIX — copie e cole este código no app do seu banco:</p>
<p><code>${brCode}</code></p>`,
      crypto: ({ amount, currency, address, memo }) =>
        `<p>Envie <strong>${amount} ${currency}</strong> para:</p>
<p><code>${address}</code></p>${memo ? `<p>Memo/tag: <code>${memo}</code></p>` : ''}`,
      fallback: ({ checkoutUrl }) => `<p><a href="${checkoutUrl}">Concluir o pagamento</a></p>`,
    },
  },
};

/** How to pay, per instrument. Never includes a credential of ours. */
function paymentInstructions(payment: ChargePayload, t: EmailTemplates): string {
  switch (payment.method) {
    case 'pix':
      return t.payment.pix({ brCode: escapeHtml(payment.brCode) });
    case 'crypto':
      return t.payment.crypto({
        amount: escapeHtml(payment.payAmount),
        currency: escapeHtml(payment.payCurrency),
        address: escapeHtml(payment.payAddress),
        memo: payment.payMemo ? escapeHtml(payment.payMemo) : null,
      });
    default:
      return t.payment.fallback({ checkoutUrl: escapeHtml(payment.checkoutUrl) });
  }
}

/**
 * Render both templates for one locale. Exported so the email suite can assert
 * on the exact subject/body a locale produces without a Resend client; the
 * Resend-backed emailer below is a thin transport around it.
 */
export function renderVerificationEmail(
  verifyToken: string,
  locale: Locale,
): { subject: string; html: string } {
  const t = TEMPLATES[toLocale(locale)];
  const url = escapeHtml(verificationUrl(verifyToken));
  return { subject: t.verification.subject, html: t.verification.body({ url }) };
}

export function renderRenewalReminderEmail(
  params: RenewalReminderParams,
  locale: Locale,
): { subject: string; html: string } {
  const safeLocale = toLocale(locale);
  const t = TEMPLATES[safeLocale];
  const model = escapeHtml(params.modelName);
  return {
    subject: t.renewalReminder.subject({ model }),
    html: t.renewalReminder.body({
      model,
      tier: escapeHtml(params.tier),
      periodEnd: escapeHtml(formatDate(params.currentPeriodEnd, safeLocale)),
      amount: escapeHtml(formatAmount(params.amountCents, params.currency, safeLocale)),
      instructions: paymentInstructions(params.payment, t),
      manageUrl: escapeHtml(`${env.APP_URL}/subscriptions`),
    }),
  };
}

/** Real Resend-backed emailer. */
export function createResendEmailer(apiKey: string = env.EMAIL_API_KEY): Emailer {
  const resend = new Resend(apiKey);
  return {
    async sendVerificationEmail(to, verifyToken, locale) {
      const { subject, html } = renderVerificationEmail(verifyToken, locale);
      await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html });
    },

    async sendRenewalReminderEmail(to, params, locale) {
      const { subject, html } = renderRenewalReminderEmail(params, locale);
      await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html });
    },
  };
}
