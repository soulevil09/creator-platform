// =============================================================================
// MockPayoutProvider — deterministic, offline stand-in for Paxum.
//
// Mirrors `MockPaymentProvider` on the payments side, and exists for the same
// two reasons: the Paxum Business account is not approved yet, so
// `PAYOUT_PROVIDER=mock` gives a working payout run with no network; and it is
// what proves the abstraction holds — flipping one env var swaps the adapter
// class with no other change anywhere in the codebase.
//
// No HTTP client, no timers, no randomness a test would have to pin.
// =============================================================================
import type { PayoutProviderName } from '@creator-platform/shared';
import type { WebhookHeaders } from '../../payments/provider.interface.js';
import { hmac, headerValue, safeEquals } from '../../payments/adapters/signature.js';
import type {
  IPayoutProvider,
  NormalizedPayoutEvent,
  PayoutParams,
  PayoutResult,
} from '../provider.interface.js';
import { PayoutProviderError } from '../provider.interface.js';

const SIGNATURE_HEADER = 'x-mock-payout-signature';

/** Secret used by the mock payout channel; never a real credential. */
export const MOCK_PAYOUT_IPN_SECRET = 'mock-payout-ipn-secret';

interface MockPayoutIpnBody {
  correlationId?: string;
  transactionId?: string;
  status?: string;
}

export interface MockPayoutAdapterConfig {
  ipnSecret?: string;
}

export class MockPayoutProvider implements IPayoutProvider {
  readonly name: PayoutProviderName = 'PAXUM_MOCK';

  private readonly ipnSecret: string;

  /** Batches sent in this process, for assertions and local debugging. */
  private readonly batches: PayoutParams[] = [];

  constructor(config: MockPayoutAdapterConfig = {}) {
    this.ipnSecret = config.ipnSecret ?? MOCK_PAYOUT_IPN_SECRET;
  }

  async createPayout(params: PayoutParams): Promise<PayoutResult> {
    if (params.recipients.length === 0) {
      throw new PayoutProviderError(this.name, 'Mock payout batch had no recipients');
    }
    this.batches.push(params);

    // Accepted, not settled: a real provider confirms asynchronously by IPN, so
    // the mock leaves every item PENDING and lets the test drive the callback.
    return {
      provider: this.name,
      providerBatchId: `mock_batch_${params.recipients[0].correlationId}`,
      items: params.recipients.map((recipient) => ({
        modelId: recipient.modelId,
        correlationId: recipient.correlationId,
        providerPayoutId: `mock_payout_${recipient.correlationId}`,
        status: 'PENDING' as const,
      })),
    };
  }

  /** Batches sent so far (tests/local debugging only). */
  getBatches(): readonly PayoutParams[] {
    return this.batches;
  }

  verifyWebhookSignature(rawBody: Buffer, headers: WebhookHeaders): boolean {
    const provided = headerValue(headers, SIGNATURE_HEADER);
    if (!provided) return false;
    try {
      return safeEquals(provided, hmac('sha256', this.ipnSecret, rawBody, 'hex'));
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer): NormalizedPayoutEvent {
    let body: MockPayoutIpnBody;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as MockPayoutIpnBody;
    } catch (err) {
      throw new PayoutProviderError(this.name, 'Mock payout IPN body was not JSON', err);
    }
    if (!body.correlationId) {
      throw new PayoutProviderError(this.name, 'Mock payout IPN had no correlationId');
    }
    const raw = (body.status ?? 'PAID').toUpperCase();
    return {
      provider: this.name,
      correlationId: body.correlationId,
      providerPayoutId: body.transactionId ?? `mock_payout_${body.correlationId}`,
      status: raw === 'PAID' || raw === 'FAILED' ? raw : 'PENDING',
      eventType: `mock_payout.${raw.toLowerCase()}`,
    };
  }
}
