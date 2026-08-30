// =============================================================================
// MockPaymentProvider — the deferred card channel.
//
// CCBill is the locked card processor (CLAUDE.md), but activating it costs
// $1,450/yr in Visa + Mastercard high-risk registration fees, so the card
// channel ships mocked at MVP. This adapter keeps the seam exercised: the
// factory, the checkout service, and the webhook pipeline all run against a
// real `IPaymentProvider`, so swapping in `CCBillAdapter` later is one class
// plus one env value.
//
// Deterministic and offline by construction — no HTTP client, no timers, no
// randomness that a test would have to pin. Signatures are HMAC-SHA256 over the
// raw body under a locally held secret, mirroring the shape CCBill's salt-based
// verification will take.
//
// The channel is configurable so this adapter can also stand in for PIX or
// crypto in local development, where the real provider credentials do not
// exist yet: `PAYMENT_PROVIDER_PIX=mock` gives a working checkout with no
// network. It is never a valid production setting for a live channel.
// =============================================================================
import type {
  MockChargePayload,
  PaymentChannel,
  PaymentProviderName,
} from '@creator-platform/shared';
import type {
  ChargeResult,
  CreateChargeParams,
  IPaymentProvider,
  NormalizedPaymentEvent,
  NormalizedPaymentStatus,
  WebhookHeaders,
} from '../provider.interface.js';
import { PaymentProviderError } from '../provider.interface.js';
import { hmac, headerValue, safeEquals } from './signature.js';

const SIGNATURE_HEADER = 'x-mock-signature';

/** Secret used by the mock channel; never a real credential. */
export const MOCK_WEBHOOK_SECRET = 'mock-card-webhook-secret';

interface MockWebhookBody {
  correlationId?: string;
  transactionId?: string;
  status?: string;
}

export interface MockAdapterConfig {
  /** Channel this instance serves. Defaults to the deferred card slot. */
  channel?: PaymentChannel;
  webhookSecret?: string;
}

export class MockPaymentProvider implements IPaymentProvider {
  readonly name: PaymentProviderName = 'CCBILL_MOCK';
  readonly channel: PaymentChannel;

  private readonly webhookSecret: string;

  /** Charges raised in this process, for assertions and local debugging. */
  private readonly charges = new Map<string, ChargeResult>();

  constructor(config: MockAdapterConfig = {}) {
    this.channel = config.channel ?? 'card';
    this.webhookSecret = config.webhookSecret ?? MOCK_WEBHOOK_SECRET;
  }

  async createCharge(params: CreateChargeParams): Promise<ChargeResult> {
    const payment: MockChargePayload = {
      method: 'mock',
      checkoutUrl: `https://mock-card.local/checkout/${params.correlationId}`,
    };
    const result: ChargeResult = {
      provider: this.name,
      providerChargeId: `mock_${params.correlationId}`,
      providerSubscriptionId:
        params.kind === 'subscription' ? `mock_sub_${params.correlationId}` : null,
      correlationId: params.correlationId,
      amountCents: params.amountCents,
      currency: params.currency,
      expiresAt: null,
      payment,
    };
    this.charges.set(params.correlationId, result);
    return result;
  }

  /** Read back a charge raised in this process (tests/local debugging only). */
  getCharge(correlationId: string): ChargeResult | undefined {
    return this.charges.get(correlationId);
  }

  verifyWebhookSignature(rawBody: Buffer, headers: WebhookHeaders): boolean {
    const provided = headerValue(headers, SIGNATURE_HEADER);
    if (!provided) return false;
    try {
      return safeEquals(provided, hmac('sha256', this.webhookSecret, rawBody, 'hex'));
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer): NormalizedPaymentEvent {
    let body: MockWebhookBody;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as MockWebhookBody;
    } catch (err) {
      throw new PaymentProviderError(this.name, 'Mock webhook body was not JSON', err);
    }
    if (!body.correlationId) {
      throw new PaymentProviderError(this.name, 'Mock webhook had no correlationId');
    }
    const raw = (body.status ?? 'CONFIRMED').toUpperCase();
    const status: NormalizedPaymentStatus =
      raw === 'CONFIRMED' || raw === 'FAILED' ? raw : 'PENDING';
    return {
      provider: this.name,
      correlationId: body.correlationId,
      providerTransactionId: body.transactionId ?? `mock_${body.correlationId}`,
      status,
      eventType: `mock.${raw.toLowerCase()}`,
    };
  }
}
