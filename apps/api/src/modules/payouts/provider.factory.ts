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
import {
  DISABLED,
  PROVIDER_CHANNELS,
  ProviderModeError,
  resolveProviderMode,
} from '../../lib/provider-mode.js';
import { PayoutProviderConfigError, type IPayoutProvider } from './provider.interface.js';
import { PaxumAdapter } from './adapters/paxum.adapter.js';
import { MockPayoutProvider } from './adapters/mock.adapter.js';

const ENV_VAR = 'PAYOUT_PROVIDER';

let cached: IPayoutProvider | null = null;

// Read straight from `process.env` (rather than the frozen `env` snapshot) so
// that flipping the variable and clearing the cache is genuinely all it takes
// to swap an adapter — the property the factory test asserts. Accepted values,
// the `disabled` default and the production `mock` ban live in
// lib/provider-mode.ts (Session 13, D1).
function configuredName(): string {
  try {
    return resolveProviderMode('payout', process.env);
  } catch (err) {
    if (err instanceof ProviderModeError) throw new PayoutProviderConfigError(err.message);
    throw err;
  }
}

/** Whether the payout channel has an adapter at all. Business code asks this, never env. */
export function isEnabled(): boolean {
  return configuredName() !== DISABLED;
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
          `Supported: ${PROVIDER_CHANNELS.payout.allowed.join(', ')}.`,
      );
  }
}

/**
 * Resolve the configured adapter, memoised for the process. Throws
 * `PayoutProviderConfigError` on an invalid value and when the payout channel is disabled —
 * callers check `isEnabled` first, so reaching this while disabled is a bug.
 */
export function getPayoutProvider(): IPayoutProvider {
  if (cached) return cached;

  const name = configuredName();
  if (name === DISABLED) {
    throw new PayoutProviderConfigError(`[payouts] disabled (${ENV_VAR}).`);
  }

  cached = instantiate(name);
  return cached;
}

/** Boot-time check: the value must be valid and an enabled adapter must construct. */
export function assertPayoutProviderConfigured(): void {
  if (isEnabled()) getPayoutProvider();
}

/** Drop the memoised adapter so a test can re-read a changed env value. */
export function resetPayoutProviderCache(): void {
  cached = null;
}
