// =============================================================================
// PaxumAdapter — model payouts via Paxum, the adult-industry standard for
// creator payouts (Paxum-to-Paxum P2P transfer, recipients addressed by the
// email on their personal Paxum account).
//
// ⚠️ FIELD NAMES ARE PROVISIONAL — SEE CLAUDE.md OPEN ITEMS.
//
// The Paxum Business account is still pending approval, so the mass-payout REST
// surface could not be exercised against a live sandbox. What IS documented
// publicly, and what this adapter is therefore built around:
//
//   * Payouts are Paxum-to-Paxum transfers; the recipient is identified by the
//     email address on their Paxum account, not by a bank/IBAN detail.
//   * A batch ("mass pay") is submitted in one call and each item settles
//     independently — one rejected recipient does not void the others.
//   * Settlement is asynchronous: the API accepts the batch, and an IPN
//     callback reports the terminal state per item later.
//   * Amounts are major units (a decimal string), not minor units.
//
// Everything below that level of detail — the exact path, the auth header, the
// request/response key names, and the IPN signature scheme — is written against
// those documented mechanics and MUST be re-verified against a live sandbox
// batch before production. That verification is a tracked Open Item; nothing
// here should be read as confirmed fact. This is the same pre-approval posture
// Session 05 took for Woovi and NOWPayments.
//
// The seam is what matters and is real: everything provisional is confined to
// this file, behind `IPayoutProvider`. Correcting a field name later touches
// this class and nothing else.
// =============================================================================
import type { Currency, PayoutProviderName } from '@creator-platform/shared';
import type { WebhookHeaders } from '../../payments/provider.interface.js';
import { hmac, headerValue, safeEquals } from '../../payments/adapters/signature.js';
import type {
  IPayoutProvider,
  NormalizedPayoutEvent,
  PayoutItemResult,
  PayoutParams,
  PayoutResult,
  PayoutStatus,
} from '../provider.interface.js';
import { PayoutProviderError } from '../provider.interface.js';
import { postJson, type FetchLike } from './http.js';

/** PROVISIONAL — IPN signature header. Re-verify against a live callback. */
const SIGNATURE_HEADER = 'x-paxum-signature';

/** PROVISIONAL — mass-payout submission path. */
const MASS_PAYOUT_PATH = '/v1/mass-payouts';

/** PROVISIONAL — item states that mean the money landed. */
const PAID_STATUSES = new Set(['PAID', 'COMPLETED', 'SUCCESS', 'SUCCEEDED']);
/** PROVISIONAL — item states that mean this item will never settle. */
const DEAD_STATUSES = new Set(['FAILED', 'REJECTED', 'DECLINED', 'CANCELLED', 'CANCELED']);

interface PaxumPayoutItemResponse {
  correlationId?: string;
  /** Recipient email, echoed back — used only to correlate a malformed reply. */
  recipientEmail?: string;
  transactionId?: string;
  status?: string;
  errorMessage?: string;
}

interface PaxumMassPayoutResponse {
  batchId?: string;
  status?: string;
  payments?: PaxumPayoutItemResponse[];
}

interface PaxumIpnBody {
  correlationId?: string;
  transactionId?: string;
  status?: string;
}

export interface PaxumAdapterConfig {
  apiKey: string;
  ipnSecret: string;
  apiUrl: string;
  /** Public URL Paxum posts payout status callbacks back to. */
  ipnCallbackUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * Minor units → the decimal string Paxum expects. Integer arithmetic only: the
 * amount never becomes a float, it is formatted as one at the very last step
 * before serialization.
 */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Map a provider item state onto our three-outcome vocabulary. */
function normalizeStatus(raw: string | undefined): PayoutStatus {
  const value = (raw ?? '').toUpperCase();
  if (PAID_STATUSES.has(value)) return 'PAID';
  if (DEAD_STATUSES.has(value)) return 'FAILED';
  return 'PENDING';
}

export class PaxumAdapter implements IPayoutProvider {
  readonly name: PayoutProviderName = 'PAXUM';

  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: PaxumAdapterConfig) {
    // Bind late so a stubbed `globalThis.fetch` (nock) is resolved at call
    // time rather than captured at construction.
    this.fetchImpl = config.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  async createPayout(params: PayoutParams): Promise<PayoutResult> {
    if (params.recipients.length === 0) {
      throw new PayoutProviderError(this.name, 'Paxum payout batch had no recipients');
    }

    const currencies = new Set(params.recipients.map((r) => r.currency));
    if (currencies.size > 1) {
      // One batch settles in one currency. The run groups by model, so this can
      // only fire if a caller hand-assembles a mixed batch.
      throw new PayoutProviderError(
        this.name,
        `Paxum batches settle in one currency (got ${[...currencies].join(', ')})`,
      );
    }
    const currency = params.recipients[0].currency as Currency;

    const response = await postJson<PaxumMassPayoutResponse>({
      provider: this.name,
      fetchImpl: this.fetchImpl,
      url: `${this.config.apiUrl}${MASS_PAYOUT_PATH}`,
      // PROVISIONAL — Paxum's auth scheme. The key is read from env and never
      // logged, echoed into an error, or persisted on a Payout row.
      headers: { 'x-api-key': this.config.apiKey },
      body: {
        currency,
        description: params.description,
        ...(this.config.ipnCallbackUrl ? { callbackUrl: this.config.ipnCallbackUrl } : {}),
        payments: params.recipients.map((recipient) => ({
          // The correlation id must reach the provider: the IPN echoes it back,
          // and that round trip is what makes callback processing idempotent.
          correlationId: recipient.correlationId,
          recipientEmail: recipient.destination,
          amount: centsToDecimalString(recipient.amountCents),
          currency: recipient.currency,
        })),
      },
    });

    const byCorrelation = new Map<string, PaxumPayoutItemResponse>();
    for (const item of response.payments ?? []) {
      if (item.correlationId) byCorrelation.set(item.correlationId, item);
    }

    // Build the result from what we ASKED for, not from what came back: a
    // recipient the provider silently dropped must surface as PENDING (awaiting
    // an IPN) rather than vanishing from the batch unnoticed.
    const items: PayoutItemResult[] = params.recipients.map((recipient) => {
      const item = byCorrelation.get(recipient.correlationId);
      const status = normalizeStatus(item?.status);
      return {
        modelId: recipient.modelId,
        correlationId: recipient.correlationId,
        providerPayoutId: item?.transactionId ?? null,
        status,
        ...(status === 'FAILED'
          ? { failureReason: item?.errorMessage ?? 'Paxum rejected this payout' }
          : {}),
      };
    });

    return {
      provider: this.name,
      providerBatchId: response.batchId ?? null,
      items,
    };
  }

  /**
   * PROVISIONAL — HMAC-SHA256 of the raw body under `PAXUM_IPN_SECRET`, hex,
   * compared in constant time. Like every signature check in this codebase it
   * returns a boolean and never throws, so a forged callback is rejected with
   * 400 before a single database statement runs.
   */
  verifyWebhookSignature(rawBody: Buffer, headers: WebhookHeaders): boolean {
    const provided = headerValue(headers, SIGNATURE_HEADER);
    if (!provided || !this.config.ipnSecret) return false;
    try {
      return safeEquals(provided, hmac('sha256', this.config.ipnSecret, rawBody, 'hex'));
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer): NormalizedPayoutEvent {
    let body: PaxumIpnBody;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as PaxumIpnBody;
    } catch (err) {
      throw new PayoutProviderError(this.name, 'Paxum IPN body was not JSON', err);
    }

    const correlationId = body.correlationId;
    if (!correlationId) {
      throw new PayoutProviderError(this.name, 'Paxum IPN had no correlationId');
    }

    const rawStatus = body.status ?? '';
    return {
      provider: this.name,
      correlationId,
      providerPayoutId: body.transactionId ?? correlationId,
      status: normalizeStatus(rawStatus),
      eventType: `paxum.${(rawStatus || 'unknown').toLowerCase()}`,
    };
  }
}
