// =============================================================================
// Provider factory — the only place that maps an env value to an adapter class.
//
// `PAYMENT_PROVIDER_PIX`, `PAYMENT_PROVIDER_CRYPTO`, and `PAYMENT_PROVIDER_CARD`
// each name one adapter. An unrecognised name is a configuration error, not a
// silent fallback: `assertPaymentProvidersConfigured()` runs at server boot so
// a typo crashes the process instead of surfacing as a failed checkout in
// production.
//
// Adapters are memoised per channel — they are stateless HTTP clients, so one
// instance per process is enough and keeps `getPaymentProvider` cheap enough to
// call inside a request handler.
// =============================================================================
import type { PaymentChannel, SubscriptionTier } from '@creator-platform/shared';
import { env } from '../../lib/env.js';
import { PaymentProviderConfigError, type IPaymentProvider } from './provider.interface.js';
import { WooviPixAdapter } from './adapters/woovi.adapter.js';
import { NOWPaymentsAdapter } from './adapters/nowpayments.adapter.js';
import { MockPaymentProvider } from './adapters/mock.adapter.js';

/**
 * Adapter names accepted per channel.
 *
 * `mock` is additionally allowed on pix/crypto as an offline development
 * setting — it makes checkout work before the Woovi and NOWPayments merchant
 * accounts are approved, and it is what proves the abstraction holds: flipping
 * `PAYMENT_PROVIDER_PIX` from `woovi` to `mock` swaps the adapter class with no
 * other change anywhere in the codebase.
 *
 * The card channel accepts `mock` and nothing else: CCBill is deferred
 * post-MVP and must be wired in deliberately, never by flipping an env var.
 */
const SUPPORTED: Record<PaymentChannel, readonly string[]> = {
  pix: ['woovi', 'mock'],
  crypto: ['nowpayments', 'mock'],
  card: ['mock'],
};

const ENV_VAR: Record<PaymentChannel, string> = {
  pix: 'PAYMENT_PROVIDER_PIX',
  crypto: 'PAYMENT_PROVIDER_CRYPTO',
  card: 'PAYMENT_PROVIDER_CARD',
};

/** Adapter used when the channel's env var is unset. */
const DEFAULT_NAME: Record<PaymentChannel, string> = {
  pix: 'woovi',
  crypto: 'nowpayments',
  card: 'mock',
};

const cache = new Map<PaymentChannel, IPaymentProvider>();

// Read straight from `process.env` (rather than the frozen `env` snapshot) so
// that flipping a variable and clearing the cache is genuinely all it takes to
// swap an adapter — the property the factory test asserts.
function configuredName(channel: PaymentChannel): string {
  return (process.env[ENV_VAR[channel]] ?? DEFAULT_NAME[channel]).trim().toLowerCase();
}

function instantiate(channel: PaymentChannel, name: string): IPaymentProvider {
  switch (name) {
    case 'woovi':
      return new WooviPixAdapter({
        appId: env.OPENPIX_APP_ID,
        webhookSecret: env.OPENPIX_WEBHOOK_SECRET,
        apiUrl: env.OPENPIX_API_URL,
        webhookUrl: `${env.API_PUBLIC_URL}/api/payments/woovi/webhook`,
      });
    case 'nowpayments': {
      const planIds: Partial<Record<SubscriptionTier, string>> = {};
      if (env.NOWPAYMENTS_PLAN_ID_STANDARD) planIds.STANDARD = env.NOWPAYMENTS_PLAN_ID_STANDARD;
      if (env.NOWPAYMENTS_PLAN_ID_PREMIUM) planIds.PREMIUM = env.NOWPAYMENTS_PLAN_ID_PREMIUM;
      return new NOWPaymentsAdapter({
        apiKey: env.NOWPAYMENTS_API_KEY,
        ipnSecret: env.NOWPAYMENTS_IPN_SECRET,
        apiUrl: env.NOWPAYMENTS_API_URL,
        ipnCallbackUrl: `${env.API_PUBLIC_URL}/api/payments/nowpayments/webhook`,
        planIds,
      });
    }
    case 'mock':
      return new MockPaymentProvider({ channel });
    default:
      throw new PaymentProviderConfigError(
        `[payments] ${ENV_VAR[channel]}="${name}" is not a known adapter. ` +
          `Supported for the ${channel} channel: ${SUPPORTED[channel].join(', ')}.`,
      );
  }
}

/**
 * Resolve the adapter serving one channel. Throws `PaymentProviderConfigError`
 * when the env value is not valid for that channel — in particular, any card
 * value other than `mock` (CCBill is deferred post-MVP and must be wired in
 * deliberately, never by flipping an env var).
 */
export function getPaymentProvider(channel: PaymentChannel): IPaymentProvider {
  const cached = cache.get(channel);
  if (cached) return cached;

  const name = configuredName(channel);
  if (!SUPPORTED[channel].includes(name)) {
    throw new PaymentProviderConfigError(
      `[payments] ${ENV_VAR[channel]}="${name}" is not supported for the ${channel} channel. ` +
        `Supported: ${SUPPORTED[channel].join(', ')}.`,
    );
  }

  const provider = instantiate(channel, name);
  cache.set(channel, provider);
  return provider;
}

/** Boot-time check: every channel must resolve, or the process must not start. */
export function assertPaymentProvidersConfigured(): void {
  for (const channel of Object.keys(SUPPORTED) as PaymentChannel[]) {
    getPaymentProvider(channel);
  }
}

/** Drop memoised adapters so a test can re-read changed env values. */
export function resetPaymentProviderCache(): void {
  cache.clear();
}
