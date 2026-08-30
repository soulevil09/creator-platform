// =============================================================================
// NOWPaymentsAdapter — crypto charges via NOWPayments, the global channel.
//
// Endpoints used (NOWPayments REST v1):
//   POST /v1/payment        → one payment, returns pay_address + pay_amount
//   POST /v1/subscriptions  → attaches a payer to a recurring plan
//
// Charges are priced in fiat (`price_amount` / `price_currency`) and settled in
// whatever coin the payer picks — the platform never quotes crypto itself.
//
// Recurrence is optional at MVP: NOWPayments subscriptions require plans
// created ahead of time in the dashboard, so when the plan id for a tier is not
// configured we still raise the first period's payment and leave
// `providerSubscriptionId` null. That keeps checkout working before the
// merchant account is finished without pretending a recurrence exists.
//
// The IPN signature is HMAC-SHA512 over the JSON body **with keys sorted
// alphabetically** — NOWPayments' documented scheme, and the reason this
// adapter re-serializes rather than hashing the raw bytes.
// =============================================================================
import type {
  CryptoChargePayload,
  PaymentChannel,
  PaymentProviderName,
  SubscriptionTier,
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
import { postJson, type FetchLike } from './http.js';
import { hmac, headerValue, safeEquals } from './signature.js';

const SIGNATURE_HEADER = 'x-nowpayments-sig';

/** Coin the invoice defaults to when the client does not pick one. */
const DEFAULT_PAY_CURRENCY = 'usdttrc20';

/** IPN statuses that mean the funds are ours. */
const PAID_STATUSES = new Set(['finished', 'confirmed']);
/** …and the terminal failures. */
const DEAD_STATUSES = new Set(['failed', 'refunded', 'expired']);

interface NowPaymentsPaymentResponse {
  payment_id?: string | number;
  payment_status?: string;
  pay_address?: string;
  pay_amount?: number | string;
  pay_currency?: string;
  payin_extra_id?: string | null;
  order_id?: string;
  expiration_estimate_date?: string;
}

interface NowPaymentsSubscriptionResponse {
  result?: Array<{ id?: string | number }> | { id?: string | number };
}

interface NowPaymentsIpnBody {
  payment_id?: string | number;
  payment_status?: string;
  order_id?: string;
  [key: string]: unknown;
}

export interface NowPaymentsAdapterConfig {
  apiKey: string;
  ipnSecret: string;
  apiUrl: string;
  /** Public URL NOWPayments posts IPN callbacks to. */
  ipnCallbackUrl?: string;
  /** Recurring plan ids per tier; empty string = recurrence not configured. */
  planIds?: Partial<Record<SubscriptionTier, string>>;
  fetchImpl?: FetchLike;
}

/**
 * Deterministic JSON with alphabetically sorted keys at every level — the exact
 * byte sequence NOWPayments signs. Arrays keep their order (position is data).
 */
export function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

export class NOWPaymentsAdapter implements IPaymentProvider {
  readonly name: PaymentProviderName = 'NOWPAYMENTS';
  readonly channel: PaymentChannel = 'crypto';

  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: NowPaymentsAdapterConfig) {
    this.fetchImpl = config.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.config.apiKey };
  }

  async createCharge(params: CreateChargeParams): Promise<ChargeResult> {
    const payment = await postJson<NowPaymentsPaymentResponse>({
      provider: this.name,
      fetchImpl: this.fetchImpl,
      url: `${this.config.apiUrl}/v1/payment`,
      headers: this.headers(),
      body: {
        // Fiat-priced, crypto-settled: the payer's coin choice never changes
        // what we booked.
        price_amount: params.amountCents / 100,
        price_currency: params.currency.toLowerCase(),
        pay_currency: DEFAULT_PAY_CURRENCY,
        order_id: params.correlationId,
        order_description: params.description,
        ...(this.config.ipnCallbackUrl ? { ipn_callback_url: this.config.ipnCallbackUrl } : {}),
      },
    });

    if (!payment.pay_address || payment.pay_amount === undefined) {
      throw new PaymentProviderError(
        this.name,
        'NOWPayments payment response had no pay_address/pay_amount',
      );
    }

    // Recurrence registration is best-effort and only attempted when a plan id
    // exists for the tier — see the header note.
    let providerSubscriptionId: string | null = null;
    const planId = params.subscription
      ? (this.config.planIds?.[params.subscription.tier] ?? '')
      : '';
    if (params.kind === 'subscription' && planId) {
      const sub = await postJson<NowPaymentsSubscriptionResponse>({
        provider: this.name,
        fetchImpl: this.fetchImpl,
        url: `${this.config.apiUrl}/v1/subscriptions`,
        headers: this.headers(),
        body: { subscription_plan_id: planId, email: params.customer.email },
      });
      const entry = Array.isArray(sub.result) ? sub.result[0] : sub.result;
      providerSubscriptionId = entry?.id !== undefined ? String(entry.id) : null;
    }

    const cryptoPayload: CryptoChargePayload = {
      method: 'crypto',
      payAddress: payment.pay_address,
      // Kept as a string: crypto amounts have more precision than a JS number
      // can carry safely once they reach the client.
      payAmount: String(payment.pay_amount),
      payCurrency: payment.pay_currency ?? DEFAULT_PAY_CURRENCY,
      payMemo: payment.payin_extra_id ?? null,
    };

    return {
      provider: this.name,
      providerChargeId:
        payment.payment_id !== undefined ? String(payment.payment_id) : params.correlationId,
      providerSubscriptionId,
      correlationId: params.correlationId,
      amountCents: params.amountCents,
      currency: params.currency,
      expiresAt: payment.expiration_estimate_date ?? null,
      payment: cryptoPayload,
    };
  }

  /** HMAC-SHA512 (hex) over the sorted-key re-serialization of the IPN body. */
  verifyWebhookSignature(rawBody: Buffer, headers: WebhookHeaders): boolean {
    const provided = headerValue(headers, SIGNATURE_HEADER);
    if (!provided || !this.config.ipnSecret) return false;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      const expected = hmac('sha512', this.config.ipnSecret, sortedJsonStringify(parsed), 'hex');
      return safeEquals(provided.trim(), expected);
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer): NormalizedPaymentEvent {
    let body: NowPaymentsIpnBody;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as NowPaymentsIpnBody;
    } catch (err) {
      throw new PaymentProviderError(this.name, 'NOWPayments IPN body was not JSON', err);
    }

    const correlationId = body.order_id;
    if (!correlationId) {
      throw new PaymentProviderError(this.name, 'NOWPayments IPN had no order_id');
    }

    const paymentStatus = String(body.payment_status ?? '').toLowerCase();
    let status: NormalizedPaymentStatus = 'PENDING';
    if (PAID_STATUSES.has(paymentStatus)) {
      status = 'CONFIRMED';
    } else if (DEAD_STATUSES.has(paymentStatus)) {
      status = 'FAILED';
    }

    return {
      provider: this.name,
      correlationId,
      providerTransactionId:
        body.payment_id !== undefined ? String(body.payment_id) : correlationId,
      status,
      eventType: `nowpayments.${paymentStatus || 'unknown'}`,
    };
  }
}
