// =============================================================================
// IPaymentProvider — the seam every payment channel sits behind.
//
// Business logic (checkout service, credit wallet, subscription grants) calls
// ONLY these methods. Nothing outside `adapters/` may know that Woovi speaks
// `correlationID` or that NOWPayments speaks `order_id`; swapping a provider is
// a change to one adapter class plus one env var, never a change here or in the
// service layer.
//
// Three concerns, three methods:
//   createCharge            — money in (subscription or one-off credit pack)
//   verifyWebhookSignature  — is this callback really from the provider?
//   parseWebhookEvent       — flatten the provider payload to our vocabulary
//
// `verifyWebhookSignature` is deliberately synchronous and total: it returns a
// boolean and never throws, so a malformed/forged callback can be rejected
// before a single database statement runs.
// =============================================================================
import type {
  ChargePayload,
  Currency,
  PaymentProviderName,
  PaymentChannel,
  SubscriptionTier,
} from '@creator-platform/shared';

/** What a charge is being raised for. */
export type ChargeKind = 'subscription' | 'credit_pack';

/** Header bag as Fastify hands it over (values may be arrays or absent). */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface ChargeCustomer {
  id: string;
  email: string;
  name: string;
}

export interface CreateChargeParams {
  kind: ChargeKind;
  /**
   * Locally generated correlation id, also used as the `PaymentTransaction`
   * idempotency key. Adapters MUST pass it to the provider as its
   * correlation/order id so the webhook echoes it back — that round trip is
   * what makes webhook processing idempotent.
   */
  correlationId: string;
  /** Minor units (centavos/cents). Never a float, never client-supplied. */
  amountCents: number;
  currency: Currency;
  /** Human-readable line item shown to the payer. */
  description: string;
  customer: ChargeCustomer;
  /** Present only when `kind === 'subscription'`. */
  subscription?: {
    modelId: string;
    tier: SubscriptionTier;
    intervalDays: number;
  };
}

export interface ChargeResult {
  provider: PaymentProviderName;
  /** Provider-side id for this charge (Woovi transactionID, NOWPayments payment_id…). */
  providerChargeId: string;
  /** Provider-side recurrence handle, when the provider registered one. */
  providerSubscriptionId: string | null;
  correlationId: string;
  amountCents: number;
  currency: Currency;
  /** ISO timestamp after which the charge can no longer be paid, if known. */
  expiresAt: string | null;
  /** Channel-specific presentation data handed straight to the client. */
  payment: ChargePayload;
}

/** Provider events, flattened to the only three outcomes we act on. */
export type NormalizedPaymentStatus = 'CONFIRMED' | 'PENDING' | 'FAILED';

export interface NormalizedPaymentEvent {
  provider: PaymentProviderName;
  /** Echoed correlation id == our `PaymentTransaction.idempotencyKey`. */
  correlationId: string;
  providerTransactionId: string;
  status: NormalizedPaymentStatus;
  /** Provider's own event name, kept for the audit trail. */
  eventType: string;
}

export interface IPaymentProvider {
  readonly name: PaymentProviderName;
  readonly channel: PaymentChannel;

  createCharge(params: CreateChargeParams): Promise<ChargeResult>;

  /**
   * Verify the callback signature over the RAW request body (never the
   * re-serialized JSON — key order and whitespace change the digest).
   * Returns false on any mismatch, missing header, or malformed input.
   */
  verifyWebhookSignature(rawBody: Buffer, headers: WebhookHeaders): boolean;

  /** Flatten a verified provider payload. Throws only if the body is unusable. */
  parseWebhookEvent(rawBody: Buffer): NormalizedPaymentEvent;
}

/** Thrown when a provider call fails; surfaced to the client as 502. */
export class PaymentProviderError extends Error {
  constructor(
    readonly provider: PaymentProviderName,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

/** Thrown at boot when `PAYMENT_PROVIDER_*` names an adapter we don't have. */
export class PaymentProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderConfigError';
  }
}
