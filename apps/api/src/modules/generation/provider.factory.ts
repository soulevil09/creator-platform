// =============================================================================
// AI provider factory — the only place that maps `AI_PROVIDER` to an adapter
// class. Mirrors modules/payments/provider.factory.ts and
// modules/payouts/provider.factory.ts line for line.
//
// An unrecognised name is a configuration error, not a silent fallback:
// `assertAIProviderConfigured()` runs at server boot so a typo crashes the
// process instead of surfacing as a 502 after a subscriber's credits were
// debited.
// =============================================================================
import { env } from '../../lib/env.js';
import { AIProviderConfigError, type IAIProvider } from './provider.interface.js';
import { ReplicateAdapter } from './adapters/replicate.adapter.js';
import { MockAIProvider } from './adapters/mock.adapter.js';

const ENV_VAR = 'AI_PROVIDER';

/**
 * Adapter names accepted. `mock` is an offline development setting — it makes
 * generation work before the Replicate account is live, with no token and no
 * network.
 */
const SUPPORTED = ['replicate', 'mock'] as const;

/** Adapter used when `AI_PROVIDER` is unset. */
const DEFAULT_NAME = 'replicate';

let cached: IAIProvider | null = null;

// Read straight from `process.env` (rather than the frozen `env` snapshot) so
// that flipping the variable and clearing the cache is genuinely all it takes
// to swap an adapter — the property the factory test asserts.
function configuredName(): string {
  return (process.env[ENV_VAR] ?? DEFAULT_NAME).trim().toLowerCase();
}

function instantiate(name: string): IAIProvider {
  switch (name) {
    case 'replicate':
      return new ReplicateAdapter({
        apiToken: env.AI_PROVIDER_API_KEY,
        timeoutMs: env.GENERATION_TIMEOUT_MS,
      });
    case 'mock':
      return new MockAIProvider();
    default:
      throw new AIProviderConfigError(
        `[generation] ${ENV_VAR}="${name}" is not a known adapter. ` +
          `Supported: ${SUPPORTED.join(', ')}.`,
      );
  }
}

/** Resolve the configured AI adapter, memoised for the process. */
export function getAIProvider(): IAIProvider {
  if (cached) return cached;

  const name = configuredName();
  if (!(SUPPORTED as readonly string[]).includes(name)) {
    throw new AIProviderConfigError(
      `[generation] ${ENV_VAR}="${name}" is not supported. Supported: ${SUPPORTED.join(', ')}.`,
    );
  }

  cached = instantiate(name);
  return cached;
}

/** Boot-time check: the AI provider must resolve, or the process must not start. */
export function assertAIProviderConfigured(): void {
  getAIProvider();
}

/** Drop the memoised adapter so a test can re-read a changed env value. */
export function resetAIProviderCache(): void {
  cached = null;
}
