// =============================================================================
// WooviPixAdapter — PIX charges via Woovi (OpenPix), the Brazilian channel.
//
// Endpoints used (Woovi/OpenPix REST v1):
//   POST /api/v1/charge         → one PIX charge, returns brCode + QR image
//   POST /api/v1/subscriptions  → registers the recurrence (subscriptions only)
//
// A PIX charge is a one-shot payment instrument: even a "subscription" is
// settled as a charge per period. So a subscription checkout does both calls —
// first register the recurrence so Woovi generates future periods, then raise
// the charge for period 1 so the payer gets a QR code right now. Credit-pack
// checkouts do the charge call alone.
//
// Auth is the App ID in the `Authorization` header (Woovi's scheme — not a
// Bearer token). It is read from env and never logged.
//
// ⚠️ The merchant account is still in review, so these request/response shapes
// are written against the published API docs and exercised only against mocked
// HTTP. Re-verify against a live sandbox charge before going to production.
// =============================================================================
import type {
  Currency,
  PaymentChannel,
  PaymentProviderName,
  PixChargePayload,
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

/** Woovi signs webhook bodies with HMAC-SHA256, base64, in this header. */
const SIGNATURE_HEADER = 'x-webhook-signature';

/** How long a generated PIX charge stays payable (seconds). */
const CHARGE_EXPIRES_IN = 60 * 60; // 1 hour

/** Woovi charge statuses that mean "money received". */
const PAID_STATUSES = new Set(['COMPLETED', 'CONFIRMED']);
/** …and the ones that mean this charge will never be paid. */
const DEAD_STATUSES = new Set(['EXPIRED', 'CANCELLED', 'CANCELED']);

interface WooviChargeResponse {
  charge?: {
    correlationID?: string;
    transactionID?: string;
    globalID?: string;
    status?: string;
    value?: number;
    brCode?: string;
    qrCodeImage?: string;
    paymentLinkUrl?: string;
    expiresDate?: string;
  };
}

interface WooviSubscriptionResponse {
  subscription?: { globalID?: string; id?: string };
}

interface WooviWebhookBody {
  event?: string;
  charge?: {
    correlationID?: string;
    transactionID?: string;
    globalID?: string;
    status?: string;
  };
}

export interface WooviAdapterConfig {
  appId: string;
  webhookSecret: string;
  apiUrl: string;
  /** Public URL Woovi posts charge events back to. */
  webhookUrl?: string;
  fetchImpl?: FetchLike;
}

export class WooviPixAdapter implements IPaymentProvider {
  readonly name: PaymentProviderName = 'WOOVI';
  readonly channel: PaymentChannel = 'pix';

  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: WooviAdapterConfig) {
    // Bind so a stubbed `globalThis.fetch` (nock) is still resolved at call
    // time rather than captured at construction.
    this.fetchImpl = config.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  private headers(): Record<string, string> {
    return { Authorization: this.config.appId };
  }

  async createCharge(params: CreateChargeParams): Promise<ChargeResult> {
    if (params.currency !== 'BRL') {
      throw new PaymentProviderError(
        this.name,
        `Woovi settles PIX in BRL only (got ${params.currency})`,
      );
    }

    // Subscriptions: register the recurrence first so Woovi owns future
    // periods. A failure here is fatal — we must not charge for a period the
    // provider will never renew.
    let providerSubscriptionId: string | null = null;
    if (params.kind === 'subscription' && params.subscription) {
      const sub = await postJson<WooviSubscriptionResponse>({
        provider: this.name,
        fetchImpl: this.fetchImpl,
        url: `${this.config.apiUrl}/api/v1/subscriptions`,
        headers: this.headers(),
        body: {
          value: params.amountCents,
          customer: {
            name: params.customer.name,
            email: params.customer.email,
            correlationID: params.customer.id,
          },
          // Woovi bills subscriptions on a fixed day of the month; anchoring to
          // today keeps the provider's cycle aligned with our period start.
          dayGenerationCharge: new Date().getUTCDate(),
          comment: params.description,
        },
      });
      providerSubscriptionId = sub.subscription?.globalID ?? sub.subscription?.id ?? null;
    }

    const body = {
      correlationID: params.correlationId,
      value: params.amountCents,
      comment: params.description,
      expiresIn: CHARGE_EXPIRES_IN,
      customer: {
        name: params.customer.name,
        email: params.customer.email,
        correlationID: params.customer.id,
      },
      ...(this.config.webhookUrl ? { callbackUrl: this.config.webhookUrl } : {}),
    };

    const response = await postJson<WooviChargeResponse>({
      provider: this.name,
      fetchImpl: this.fetchImpl,
      url: `${this.config.apiUrl}/api/v1/charge`,
      headers: this.headers(),
      body,
    });

    const charge = response.charge;
    if (!charge?.brCode) {
      throw new PaymentProviderError(this.name, 'Woovi charge response had no brCode');
    }

    const payment: PixChargePayload = {
      method: 'pix',
      qrCodeImage: charge.qrCodeImage ?? '',
      brCode: charge.brCode,
      paymentLinkUrl: charge.paymentLinkUrl ?? null,
    };

    return {
      provider: this.name,
      providerChargeId: charge.transactionID ?? charge.globalID ?? params.correlationId,
      providerSubscriptionId,
      correlationId: params.correlationId,
      amountCents: params.amountCents,
      currency: params.currency as Currency,
      expiresAt: charge.expiresDate ?? null,
      payment,
    };
  }

  /**
   * HMAC-SHA256 of the raw body under `OPENPIX_WEBHOOK_SECRET`, base64-encoded,
   * compared in constant time. Any missing header or unconfigured secret is a
   * rejection, never an exception — the caller must be able to answer 400
   * without having touched the database.
   */
  verifyWebhookSignature(rawBody: Buffer, headers: WebhookHeaders): boolean {
    const provided = headerValue(headers, SIGNATURE_HEADER);
    if (!provided || !this.config.webhookSecret) return false;
    try {
      return safeEquals(provided, hmac('sha256', this.config.webhookSecret, rawBody, 'base64'));
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer): NormalizedPaymentEvent {
    let body: WooviWebhookBody;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as WooviWebhookBody;
    } catch (err) {
      throw new PaymentProviderError(this.name, 'Woovi webhook body was not JSON', err);
    }

    const charge = body.charge;
    const correlationId = charge?.correlationID;
    if (!correlationId) {
      throw new PaymentProviderError(this.name, 'Woovi webhook had no charge.correlationID');
    }

    const eventType = body.event ?? 'OPENPIX:UNKNOWN';
    const chargeStatus = (charge?.status ?? '').toUpperCase();

    let status: NormalizedPaymentStatus = 'PENDING';
    if (eventType === 'OPENPIX:CHARGE_COMPLETED' || PAID_STATUSES.has(chargeStatus)) {
      status = 'CONFIRMED';
    } else if (eventType === 'OPENPIX:CHARGE_EXPIRED' || DEAD_STATUSES.has(chargeStatus)) {
      status = 'FAILED';
    }

    return {
      provider: this.name,
      correlationId,
      providerTransactionId: charge?.transactionID ?? charge?.globalID ?? correlationId,
      status,
      eventType,
    };
  }
}
