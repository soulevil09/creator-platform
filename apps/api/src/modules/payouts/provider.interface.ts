// =============================================================================
// IPayoutProvider — money OUT: the platform paying models their share.
//
// Deliberately separate from `IPaymentProvider`: money in and money out have
// different providers (Woovi/NOWPayments vs Paxum), different failure modes
// (a payout can be rejected days later), and different compliance surfaces.
// Collapsing them into one interface would force every payment adapter to
// pretend it can send money.
//
// Contract only in Session 05 — no adapter, no HTTP, no env wiring.
// TODO(Session 06): implement PaxumAdapter against the Paxum mass-payout REST
// API and wire it behind a `PAYOUT_PROVIDER` env var, mirroring
// modules/payments/provider.factory.ts.
// =============================================================================
import type { Currency } from '@creator-platform/shared';
import type { WebhookHeaders } from '../payments/provider.interface.js';

/** Where one model's earnings are sent. Paxum addresses recipients by email. */
export interface PayoutRecipient {
  /** Our `User.id` for the model being paid. */
  modelId: string;
  /** Recipient account identifier at the payout provider (Paxum email). */
  destination: string;
  /** Minor units (cents) — the model's share, already net of the platform cut. */
  amountCents: number;
  currency: Currency;
  /** Local idempotency key so a retried batch cannot pay twice. */
  correlationId: string;
}

export interface PayoutParams {
  /** One batch of recipients, sent as a single mass payout where supported. */
  recipients: PayoutRecipient[];
  /** Free-text label shown on the provider's statement. */
  description: string;
}

export type PayoutStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface PayoutItemResult {
  modelId: string;
  correlationId: string;
  providerPayoutId: string | null;
  status: PayoutStatus;
  /** Provider-supplied reason when `status === 'FAILED'`. */
  failureReason?: string;
}

export interface PayoutResult {
  provider: string;
  /** Provider-side handle for the whole batch, when it issues one. */
  providerBatchId: string | null;
  items: PayoutItemResult[];
}

/** Payout status callback, normalized the way payment events are. */
export interface NormalizedPayoutEvent {
  provider: string;
  correlationId: string;
  providerPayoutId: string;
  status: PayoutStatus;
  eventType: string;
}

export interface IPayoutProvider {
  readonly name: string;

  /** Send one batch of payouts. Must be idempotent on `correlationId`. */
  createPayout(params: PayoutParams): Promise<PayoutResult>;

  /**
   * Verify a payout status callback over the RAW body. Like its payments
   * counterpart, returns a boolean and never throws, so a forged callback is
   * rejected before any database access.
   */
  verifyWebhookSignature(rawBody: Buffer, headers: WebhookHeaders): boolean;

  /** Flatten a verified payout callback. */
  parseWebhookEvent(rawBody: Buffer): NormalizedPayoutEvent;
}
