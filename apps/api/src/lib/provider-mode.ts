// =============================================================================
// Provider modes (Session 13, D1) — the one place that decides which adapter,
// if any, serves each external channel.
//
// Every channel is `disabled` unless an env var names an adapter: an account
// that is not live is switched OFF (fail closed: 503/404), never silently
// mocked. `mock` exists for development and tests only — `MockPaymentProvider`
// verifies webhooks against a hardcoded, public secret, so in production it
// would let anyone mint "confirmed" payments; a production boot naming `mock`
// on any channel crashes. Resend is rejected in production because its AUP
// bars adult businesses.
//
// Pure over its `source` argument: `loadEnv` (boot) and every factory's
// `isEnabled` (request time, reading `process.env` live like the factories
// always have) call the same function, so they cannot disagree.
// =============================================================================
import type { EnvSource } from './env.js';

export type ProviderChannel = 'pix' | 'crypto' | 'card' | 'payout' | 'ai' | 'email';

/** The value every channel resolves to when it is switched off (or unset). */
export const DISABLED = 'disabled';

interface ChannelSpec {
  envVar: string;
  /** Every accepted value, `disabled` included. */
  allowed: readonly string[];
  /** The subset a `NODE_ENV=production` boot accepts. */
  productionAllowed: readonly string[];
}

export const PROVIDER_CHANNELS: Readonly<Record<ProviderChannel, ChannelSpec>> = {
  pix: {
    envVar: 'PAYMENT_PROVIDER_PIX',
    allowed: ['woovi', 'mock', DISABLED],
    productionAllowed: ['woovi', DISABLED],
  },
  crypto: {
    envVar: 'PAYMENT_PROVIDER_CRYPTO',
    allowed: ['nowpayments', 'mock', DISABLED],
    productionAllowed: ['nowpayments', DISABLED],
  },
  // CCBill is deferred post-MVP and must be wired in deliberately — there is
  // no value that selects a real card processor today.
  card: {
    envVar: 'PAYMENT_PROVIDER_CARD',
    allowed: ['mock', DISABLED],
    productionAllowed: [DISABLED],
  },
  payout: {
    envVar: 'PAYOUT_PROVIDER',
    allowed: ['paxum', 'mock', DISABLED],
    productionAllowed: ['paxum', DISABLED],
  },
  ai: {
    envVar: 'AI_PROVIDER',
    allowed: ['replicate', 'mock', DISABLED],
    productionAllowed: ['replicate', DISABLED],
  },
  // Resend stays for non-production only until a provider that accepts adult
  // businesses (Mailgun / SES) gets an adapter of its own.
  email: {
    envVar: 'EMAIL_PROVIDER',
    allowed: ['resend', 'mock', DISABLED],
    productionAllowed: [DISABLED],
  },
};

/** A provider env var holds a value this deployment must not boot with. */
export class ProviderModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderModeError';
  }
}

function productionRefusal(envVar: string, value: string): string {
  if (value === 'mock') {
    return (
      `[providers] ${envVar}=mock is not allowed in production: mock adapters accept ` +
      `webhooks signed with a public test secret. Use a real adapter or "disabled".`
    );
  }
  if (envVar === 'EMAIL_PROVIDER' && value === 'resend') {
    return (
      `[providers] EMAIL_PROVIDER=resend is not allowed in production: Resend's acceptable ` +
      `use policy bars adult businesses. Use "disabled" until another provider is wired in.`
    );
  }
  return `[providers] ${envVar}="${value}" is not allowed in production.`;
}

/**
 * The adapter name serving `channel`, or `disabled`. Throws
 * `ProviderModeError` on an unknown value (in any environment) and on a value
 * production refuses, naming the variable — never the value of a secret.
 */
export function resolveProviderMode(channel: ProviderChannel, source: EnvSource): string {
  const spec = PROVIDER_CHANNELS[channel];
  const value = (source[spec.envVar] ?? '').trim().toLowerCase() || DISABLED;
  if (!spec.allowed.includes(value)) {
    throw new ProviderModeError(
      `[providers] ${spec.envVar}="${value}" is not a known value. ` +
        `Allowed: ${spec.allowed.join(', ')}.`,
    );
  }
  if (source.NODE_ENV === 'production' && !spec.productionAllowed.includes(value)) {
    throw new ProviderModeError(productionRefusal(spec.envVar, value));
  }
  return value;
}

/** Resolve every channel at once (boot). */
export function resolveProviderModes(source: EnvSource): Record<ProviderChannel, string> {
  const modes = {} as Record<ProviderChannel, string>;
  for (const channel of Object.keys(PROVIDER_CHANNELS) as ProviderChannel[]) {
    modes[channel] = resolveProviderMode(channel, source);
  }
  return modes;
}
