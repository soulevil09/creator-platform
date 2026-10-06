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
import {
  DISABLED,
  PROVIDER_CHANNELS,
  ProviderModeError,
  resolveProviderMode,
} from '../../lib/provider-mode.js';
import { AIProviderConfigError, type IAIProvider } from './provider.interface.js';
import { ReplicateAdapter } from './adapters/replicate.adapter.js';
import { MockAIProvider } from './adapters/mock.adapter.js';

const ENV_VAR = 'AI_PROVIDER';

let cached: IAIProvider | null = null;

// Read straight from `process.env` (rather than the frozen `env` snapshot) so
// that flipping the variable and clearing the cache is genuinely all it takes
// to swap an adapter — the property the factory test asserts. Accepted values,
// the `disabled` default and the production `mock` ban live in
// lib/provider-mode.ts (Session 13, D1).
function configuredName(): string {
  try {
    return resolveProviderMode('ai', process.env);
  } catch (err) {
    if (err instanceof ProviderModeError) throw new AIProviderConfigError(err.message);
    throw err;
  }
}

/** Whether AI generation has an adapter at all. Business code asks this, never env. */
export function isEnabled(): boolean {
  return configuredName() !== DISABLED;
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
          `Supported: ${PROVIDER_CHANNELS.ai.allowed.join(', ')}.`,
      );
  }
}

/**
 * Resolve the configured adapter, memoised for the process. Throws
 * `AIProviderConfigError` on an invalid value and when AI generation is disabled —
 * callers check `isEnabled` first, so reaching this while disabled is a bug.
 */
export function getAIProvider(): IAIProvider {
  if (cached) return cached;

  const name = configuredName();
  if (name === DISABLED) {
    throw new AIProviderConfigError(`[generation] disabled (${ENV_VAR}).`);
  }

  cached = instantiate(name);
  return cached;
}

/** Boot-time check: the value must be valid and an enabled adapter must construct. */
export function assertAIProviderConfigured(): void {
  if (isEnabled()) getAIProvider();
}

/** Drop the memoised adapter so a test can re-read a changed env value. */
export function resetAIProviderCache(): void {
  cached = null;
}
