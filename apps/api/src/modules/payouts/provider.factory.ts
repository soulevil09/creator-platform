// =============================================================================
// Payout provider factory — the only place that maps `PAYOUT_PROVIDER` to an
// adapter class. Mirrors modules/payments/provider.factory.ts exactly, and
// lives here rather than there so the payments module never has to import a
// payout adapter: money in and money out stay separable.
//
// An unrecognised name is a configuration error, not a silent fallback:
// `assertPayoutProviderConfigured()` runs at server boot so a typo crashes the
// process instead of surfacing as a skipped weekly payout run nobody notices.
// =============================================================================
import { env } from '../../lib/env.js';
import { PayoutProviderConfigError, type IPayoutProvider } from './provider.interface.js';
import { PaxumAdapter } from './adapters/paxum.adapter.js';
import { MockPayoutProvider } from './adapters/mock.adapter.js';

const ENV_VAR = 'PAYOUT_PROVIDER';

/**
 * Adapter names accepted. `mock` is an offline development setting — it makes
 * a payout run work before the Paxum Business account is approved, with no
 * network and no credentials.
 */
const SUPPORTED = ['paxum', 'mock'] as const;

/** Adapter used when `PAYOUT_PROVIDER` is unset. */
const DEFAULT_NAME = 'paxum';

let cached: IPayoutProvider | null = null;

// Read straight from `process.env` (rather than the frozen `env` snapshot) so
// that flipping the variable and clearing the cache is genuinely all it takes
// to swap an adapter — the property the factory test asserts.
function configuredName(): string {
  return (process.env[ENV_VAR] ?? DEFAULT_NAME).trim().toLowerCase();
}

function instantiate(name: string): IPayoutProvider {
  switch (name) {
    case 'paxum':
      return new PaxumAdapter({
        apiKey: env.PAXUM_API_KEY,
        ipnSecret: env.PAXUM_IPN_SECRET,
        apiUrl: env.PAXUM_API_URL,
        ipnCallbackUrl: `${env.API_PUBLIC_URL}/api/payouts/paxum/webhook`,
      });
    case 'mock':
      return new MockPayoutProvider();
    default:
      throw new PayoutProviderConfigError(
        `[payouts] ${ENV_VAR}="${name}" is not a known adapter. ` +
          `Supported: ${SUPPORTED.join(', ')}.`,
      );
  }
}

/** Resolve the configured payout adapter, memoised for the process. */
export function getPayoutProvider(): IPayoutProvider {
  if (cached) return cached;

  const name = configuredName();
  if (!(SUPPORTED as readonly string[]).includes(name)) {
    throw new PayoutProviderConfigError(
      `[payouts] ${ENV_VAR}="${name}" is not supported. Supported: ${SUPPORTED.join(', ')}.`,
    );
  }

  cached = instantiate(name);
  return cached;
}

/** Boot-time check: the payout provider must resolve, or the process must not start. */
export function assertPayoutProviderConfigured(): void {
  getPayoutProvider();
}

/** Drop the memoised adapter so a test can re-read a changed env value. */
export function resetPayoutProviderCache(): void {
  cached = null;
}
