// Transactional email via Resend (free tier; swappable behind this interface).
//
// The rest of the app depends only on the `Emailer` interface, so tests inject a
// fake and Session 13+ can swap providers without touching auth code.
import { Resend } from 'resend';
import type { ChargePayload, SubscriptionTier } from '@creator-platform/shared';
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
  sendVerificationEmail(to: string, verifyToken: string): Promise<void>;
  sendRenewalReminderEmail(to: string, params: RenewalReminderParams): Promise<void>;
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

/** Minor units → a human amount. Integer arithmetic only. */
function formatAmount(amountCents: number, currency: string): string {
  const whole = Math.trunc(amountCents / 100);
  const fraction = String(Math.abs(amountCents % 100)).padStart(2, '0');
  return `${currency} ${whole}.${fraction}`;
}

/** How to pay, per instrument. Never includes a credential of ours. */
function paymentInstructions(payment: ChargePayload): string {
  switch (payment.method) {
    case 'pix':
      return `<p>Pay with PIX — copy and paste this code into your bank app:</p>
<p><code>${escapeHtml(payment.brCode)}</code></p>`;
    case 'crypto':
      return `<p>Send <strong>${escapeHtml(payment.payAmount)} ${escapeHtml(payment.payCurrency)}</strong> to:</p>
<p><code>${escapeHtml(payment.payAddress)}</code></p>${
        payment.payMemo ? `<p>Memo/tag: <code>${escapeHtml(payment.payMemo)}</code></p>` : ''
      }`;
    default:
      return `<p><a href="${escapeHtml(payment.checkoutUrl)}">Complete your payment</a></p>`;
  }
}

/** Real Resend-backed emailer. */
export function createResendEmailer(apiKey: string = env.EMAIL_API_KEY): Emailer {
  const resend = new Resend(apiKey);
  return {
    async sendVerificationEmail(to, verifyToken) {
      const url = verificationUrl(verifyToken);
      await resend.emails.send({
        from: env.EMAIL_FROM,
        to,
        subject: 'Verify your email',
        html: `<p>Welcome to Creator Platform.</p>
<p>Confirm your email address by clicking the link below (valid for 24 hours):</p>
<p><a href="${url}">${url}</a></p>`,
      });
    },

    async sendRenewalReminderEmail(to, params) {
      const model = escapeHtml(params.modelName);
      await resend.emails.send({
        from: env.EMAIL_FROM,
        to,
        subject: `Your ${model} subscription renews soon`,
        html: `<p>Your ${escapeHtml(params.tier)} subscription to ${model} ends on
${params.currentPeriodEnd.toISOString().slice(0, 10)}.</p>
<p>To keep access, pay ${escapeHtml(formatAmount(params.amountCents, params.currency))}.</p>
${paymentInstructions(params.payment)}
<p>Don't want to renew? Cancel any time at <a href="${env.APP_URL}/subscriptions">${env.APP_URL}/subscriptions</a> — you keep everything you already paid for until the date above.</p>`,
      });
    },
  };
}
