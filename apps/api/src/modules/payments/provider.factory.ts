// =============================================================================
// Provider factory — the only place that maps an env value to an adapter class.
//
// `PAYMENT_PROVIDER_PIX`, `PAYMENT_PROVIDER_CRYPTO`, and `PAYMENT_PROVIDER_CARD`
// each name one adapter, or `disabled` (the default, Session 13). An
// unrecognised name is a configuration error, not a silent fallback:
// `assertPaymentProvidersConfigured()` runs at server boot so a typo crashes
// the process instead of surfacing as a failed checkout in production.
//
// Adapters are memoised per channel — they are stateless HTTP clients, so one
// instance per process is enough and keeps `getPaymentProvider` cheap enough to
// call inside a request handler.
// =============================================================================
import type { PaymentChannel, SubscriptionTier } from '@creator-platform/shared';
import { env } from '../../lib/env.js';
import {
  DISABLED,
  PROVIDER_CHANNELS,
  ProviderModeError,
  resolveProviderMode,
  type ProviderChannel,
} from '../../lib/provider-mode.js';
import { PaymentProviderConfigError, type IPaymentProvider } from './provider.interface.js';
import { WooviPixAdapter } from './adapters/woovi.adapter.js';
import { NOWPaymentsAdapter } from './adapters/nowpayments.adapter.js';
import { MockPaymentProvider } from './adapters/mock.adapter.js';

/** Payment channel → its entry in the provider-mode table (Session 13, D1). */
const MODE_CHANNEL: Record<PaymentChannel, ProviderChannel> = {
  pix: 'pix',
  crypto: 'crypto',
  card: 'card',
};

const ENV_VAR: Record<PaymentChannel, string> = {
  pix: 'PAYMENT_PROVIDER_PIX',
  crypto: 'PAYMENT_PROVIDER_CRYPTO',
  card: 'PAYMENT_PROVIDER_CARD',
};

const cache = new Map<PaymentChannel, IPaymentProvider>();

// Read straight from `process.env` (rather than the frozen `env` snapshot) so
// that flipping a variable and clearing the cache is genuinely all it takes to
// swap an adapter — the property the factory test asserts. Accepted values,
// the `disabled` default and the production `mock` ban all live in
// lib/provider-mode.ts; a refusal surfaces here as the module's typed error.
function configuredName(channel: PaymentChannel): string {
  try {
    return resolveProviderMode(MODE_CHANNEL[channel], process.env);
  } catch (err) {
    if (err instanceof ProviderModeError) throw new PaymentProviderConfigError(err.message);
    throw err;
  }
}

/**
 * Whether `channel` has an adapter at all. Business code asks this — it never
 * compares env strings itself — and answers a disabled channel with 503 (or,
 * for its webhook, by not registering the route: 404).
 */
export function isEnabled(channel: PaymentChannel): boolean {
  return configuredName(channel) !== DISABLED;
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
          `Supported for the ${channel} channel: ${PROVIDER_CHANNELS[MODE_CHANNEL[channel]].allowed.join(', ')}.`,
      );
  }
}

/**
 * Resolve the adapter serving one channel. Throws `PaymentProviderConfigError`
 * when the env value is not valid for that channel, and when the channel is
 * disabled — callers check `isEnabled` first, so reaching this for a disabled
 * channel is a bug that must fail loudly rather than fall back to a mock.
 */
export function getPaymentProvider(channel: PaymentChannel): IPaymentProvider {
  const cached = cache.get(channel);
  if (cached) return cached;

  const name = configuredName(channel);
  if (name === DISABLED) {
    throw new PaymentProviderConfigError(
      `[payments] the ${channel} channel is disabled (${ENV_VAR[channel]}).`,
    );
  }

  const provider = instantiate(channel, name);
  cache.set(channel, provider);
  return provider;
}

/**
 * Boot-time check: every channel's value must be valid, and every enabled
 * channel's adapter must construct, or the process must not start.
 */
export function assertPaymentProvidersConfigured(): void {
  for (const channel of Object.keys(MODE_CHANNEL) as PaymentChannel[]) {
    if (isEnabled(channel)) getPaymentProvider(channel);
  }
}

/** Drop memoised adapters so a test can re-read changed env values. */
export function resetPaymentProviderCache(): void {
  cache.clear();
}
