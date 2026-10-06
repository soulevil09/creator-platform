// =============================================================================
// Startup environment validation.
//
// Importing this module reads and validates the required secrets *eagerly*, so
// the process crashes at boot with a clear message if any are missing — never
// at the first request (Session 02). Session 13 made it a pure `loadEnv(source)`
// so every boot rule is unit-tested, made provider credentials conditional on
// the provider being active (lib/provider-mode.ts), and added production-only
// rules (https same-site URLs, TRUST_PROXY). No secret is ever logged.
// =============================================================================
import { isIP } from 'node:net';
import { resolveProviderModes } from './provider-mode.js';
import {
  DEFAULT_PAYOUT_MIN_THRESHOLD_CENTS,
  DEFAULT_REVENUE_SHARE_MODEL_PCT,
  DEFAULT_SUBSCRIPTION_GRACE_PERIOD_DAYS,
  DEFAULT_SUBSCRIPTION_RENEWAL_REMINDER_DAYS,
  type Currency,
} from '@creator-platform/shared';

/** Where variables are read from: `process.env` at boot, a plain object in tests. */
export type EnvSource = Record<string, string | undefined>;

function configError(message: string): Error {
  return new Error(`[env] ${message} Set it in apps/api/.env (see apps/api/.env.example).`);
}

/**
 * Required whenever `condition` holds, whatever the NODE_ENV. Used for provider
 * credentials: an active adapter without its credentials would fail at the
 * first charge, payout or generation — after money or credits moved — so it
 * must crash at boot instead. A disabled adapter needs nothing.
 */
function requiredWhen(
  source: EnvSource,
  name: string,
  condition: boolean,
  because: string,
): string {
  const value = source[name] ?? '';
  if (condition && value.trim() === '') {
    throw configError(
      `Missing required environment variable: ${name} (required because ${because}).`,
    );
  }
  return value;
}

/** Required in production, optional elsewhere (cron secrets). */
function requiredInProduction(source: EnvSource, name: string, isProduction: boolean): string {
  return requiredWhen(source, name, isProduction, 'NODE_ENV=production');
}

/**
 * A whole number with a safe default and an inclusive range. An out-of-range or
 * non-numeric value is a configuration error, not something to clamp silently:
 * `REVENUE_SHARE_MODEL_PCT=800` must crash the process, never pay a model 8x.
 */
function integerInRange(
  source: EnvSource,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = (source[name] ?? '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(`${name}="${raw}" must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

/** A fraction in [0, 1] (sample rates); out of range is a configuration error. */
function fraction(source: EnvSource, name: string, fallback: number): number {
  const raw = (source[name] ?? '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw configError(`${name}="${raw}" must be a number between 0 and 1.`);
  }
  return value;
}

function required(source: EnvSource, name: string): string {
  const value = source[name];
  if (!value || value.trim() === '') {
    throw configError(`Missing required environment variable: ${name}.`);
  }
  return value;
}

/**
 * `required`, plus a floor on length. Used for HMAC keys whose whole value is
 * their entropy: a short `WATERMARK_TRACE_SECRET` would let a leaked trace
 * code be brute-forced back to a (content, viewer) pair offline, defeating the
 * "only the AuditLog can resolve a code" property Session 09 is built on. The
 * JWT secrets get the same floor (Session 13, D2): a short HS256 key can be
 * brute-forced from any captured token, and then every session forged.
 */
function requiredMinLength(source: EnvSource, name: string, minLength: number): string {
  const value = required(source, name);
  if (value.length < minLength) {
    throw new Error(
      `[env] ${name} must be at least ${minLength} characters long. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  return value;
}

/**
 * Production URL rule (Session 13, D2): `https://`, and web + API on the same
 * registrable domain. The auth cookies are `SameSite=Strict` and the API sends
 * CORP `same-site`, so a cross-site pair breaks login and media outright.
 *
 * "Same registrable domain" is checked as "identical last two host labels".
 * That is NOT a Public Suffix List check — `a.co.uk` / `b.co.uk` would pass,
 * and `x.up.railway.app` / `y.up.railway.app` would wrongly pass too — but it
 * is exact for a two-label domain like `visorfans.com`, which is what we
 * deploy on, and it needs no PSL dependency.
 */
function httpsHost(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(`${name}="${value}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:') {
    throw configError(`${name} must be an https:// URL in production.`);
  }
  return url.hostname;
}

function registrableDomain(host: string): string {
  return host.split('.').slice(-2).join('.');
}

function assertProductionUrls(appUrl: string, apiPublicUrl: string): void {
  const appHost = httpsHost('APP_URL', appUrl);
  const apiHost = httpsHost('API_PUBLIC_URL', apiPublicUrl);
  if (registrableDomain(appHost) !== registrableDomain(apiHost)) {
    throw configError(
      `APP_URL (${appHost}) and API_PUBLIC_URL (${apiHost}) must share one registrable domain ` +
        `(SameSite=Strict cookies and CORP same-site).`,
    );
  }
}

/**
 * What Fastify's `trustProxy` option receives. Neither `true` nor a hop count
 * is a member: `true` trusts every hop, and since fastify 5.12.5 a numeric hop
 * count silently trusts *no* hop (see `parseTrustProxy`).
 */
export type TrustProxySetting = false | string[];

/** An IPv4/IPv6 address, optionally with a `/prefix` — what proxy-addr accepts. */
function isAddressOrCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length > 0 || isIP(address) === 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  const max = isIP(address) === 4 ? 32 : 128;
  return /^\d+$/.test(prefix) && bits >= 0 && bits <= max;
}

/**
 * `TRUST_PROXY` (Session 12, D1; tightened Session 13) → Fastify's `trustProxy`.
 *
 *   unset / "false" / "0" → false: `request.ip` is the socket address and
 *                           `X-Forwarded-For` is ignored entirely.
 *   "10.0.0.0/8, ::1"     → trust only those proxy addresses/CIDRs.
 *
 * `"true"` is rejected at boot rather than accepted: trusting every hop lets
 * any client write its own `X-Forwarded-For` and earn a fresh IP-scoped rate
 * budget on register/login with each request.
 *
 * A hop count ("1", "2", …) is rejected too. fastify 5.12.5 (the
 * X-Forwarded-For spoofing advisory) made a numeric `trustProxy` fail closed:
 * it trusts no hop at all, so behind Caddy every client would share Caddy's
 * address — one register/login budget for the whole internet, with no error.
 * Naming the proxy's address range is the only setting that means what it
 * says; in deployment that is the pinned compose subnet (infra/compose.yaml).
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false' || value === '0') return false;
  if (value.toLowerCase() === 'true') {
    throw new Error(
      '[env] TRUST_PROXY=true is not allowed: it lets any client spoof X-Forwarded-For. ' +
        'Use the proxy addresses/CIDRs.',
    );
  }
  if (/^\d+$/.test(value)) {
    throw new Error(
      `[env] TRUST_PROXY="${value}" looks like a hop count, which fastify >=5.12.5 treats as ` +
        `"trust no proxy". Use the proxy addresses/CIDRs (e.g. the compose subnet).`,
    );
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const invalid = entries.filter((entry) => !isAddressOrCidr(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(
      `[env] TRUST_PROXY must be false or a comma-separated list of IPs/CIDRs ` +
        `(invalid: ${invalid.join(', ') || '(empty)'}).`,
    );
  }
  return entries;
}

/**
 * 90 s: Replicate cold-boots a model container in roughly 30–60 s and a warm
 * SDXL-class run takes 10–20 s, so this covers a cold start plus generation
 * plus the output download with headroom, while still bounding how long one
 * subscriber holds a connection open.
 */
const DEFAULT_GENERATION_TIMEOUT_MS = 90_000;

/** 30 days — long enough to come back for the image, short enough to bound storage. */
const DEFAULT_GENERATION_IMAGE_RETENTION_DAYS = 30;

/** 72 h — three days without an IPN before a payout is flagged for a human. */
const DEFAULT_PAYOUT_STALE_AFTER_HOURS = 72;

const MIB = 1024 * 1024;

/**
 * Upload ceiling (Session 13). Uploads are buffered whole in memory before the
 * storage write (Open Item: no streaming multipart yet), and the API container
 * is capped at 448 MiB. 64 MiB by default; the hard ceiling below is what the
 * container can absorb — see `CONTENT_UPLOAD_MAX_BYTES` in the env object.
 */
export const DEFAULT_CONTENT_UPLOAD_MAX_BYTES = 64 * MIB;
export const CONTENT_UPLOAD_HARD_CEILING_BYTES = 96 * MIB;

/**
 * Read and validate the whole configuration from `source`. Pure apart from the
 * throw: `env` below is this applied to `process.env` once at import, and the
 * boot-rule tests call it with a plain object, so every rule is testable
 * without resetting the module registry.
 */
export function loadEnv(source: EnvSource) {
  const NODE_ENV = source.NODE_ENV ?? 'development';
  const isProduction = NODE_ENV === 'production';

  // Which adapter serves each channel, or `disabled` (Session 13, D1). Throws
  // on an unknown value, and on `mock` (or Resend) in production. Everything
  // below requires a provider's credentials only when that provider is active.
  const PROVIDERS = resolveProviderModes(source);

  const GENERATION_TIMEOUT_MS = integerInRange(
    source,
    'GENERATION_TIMEOUT_MS',
    DEFAULT_GENERATION_TIMEOUT_MS,
    1_000,
    600_000,
  );

  /**
   * Age past which a PENDING GenerationJob is treated as abandoned by the
   * reconciliation sweep (Session 12, D6). Default 2× the generation timeout.
   * It must exceed the timeout: the live request's success path completes the
   * job with a plain update, so reconciling a job whose request is still inside
   * its budget could refund credits for an image that then completes.
   */
  const GENERATION_STALE_AFTER_MS = integerInRange(
    source,
    'GENERATION_STALE_AFTER_MS',
    2 * GENERATION_TIMEOUT_MS,
    2_000,
    24 * 60 * 60 * 1000,
  );
  if (GENERATION_STALE_AFTER_MS <= GENERATION_TIMEOUT_MS) {
    throw new Error(
      `[env] GENERATION_STALE_AFTER_MS (${GENERATION_STALE_AFTER_MS}) must be greater than ` +
        `GENERATION_TIMEOUT_MS (${GENERATION_TIMEOUT_MS}).`,
    );
  }

  // Secrets — validated eagerly (throw on boot if absent). Both JWT keys get a
  // 32-char floor and must differ (Session 13, D2): with one shared key, a
  // refresh token would verify as an access token and vice versa.
  const JWT_SECRET = requiredMinLength(source, 'JWT_SECRET', 32);
  const JWT_REFRESH_SECRET = requiredMinLength(source, 'JWT_REFRESH_SECRET', 32);
  if (JWT_SECRET === JWT_REFRESH_SECRET) {
    throw new Error('[env] JWT_SECRET and JWT_REFRESH_SECRET must be different values.');
  }

  const APP_URL = source.APP_URL ?? 'http://localhost:3000';
  /** Public base URL the providers call back to with webhooks. */
  const API_PUBLIC_URL = source.API_PUBLIC_URL ?? 'http://localhost:4000';

  // ─── Security hardening (Session 12) ─────────────────────────────────────
  // Fastify `trustProxy`. Default false; never `true` or a hop count — see
  // `parseTrustProxy`. Set it to the proxy CIDRs of the deployment so
  // `request.ip`, and every IP-scoped rate limit keyed on it, is the client.
  const TRUST_PROXY = parseTrustProxy(source.TRUST_PROXY);

  // ─── Production-only rules (Session 13, D2) ──────────────────────────────
  if (isProduction) {
    required(source, 'APP_URL');
    required(source, 'API_PUBLIC_URL');
    assertProductionUrls(APP_URL, API_PUBLIC_URL);
    // Behind Caddy, `false` would make the proxy every client: one shared
    // budget for register/login across the whole internet.
    if (TRUST_PROXY === false) {
      throw configError(
        "TRUST_PROXY must be set in production to the reverse proxy's addresses/CIDRs.",
      );
    }
  }

  return {
    NODE_ENV,
    isProduction,

    JWT_SECRET,
    JWT_REFRESH_SECRET,
    PROVIDERS,

    // Resend (non-production only, Session 13): the key is required only when
    // it is the active email provider.
    EMAIL_API_KEY: requiredWhen(
      source,
      'EMAIL_API_KEY',
      PROVIDERS.email === 'resend',
      'EMAIL_PROVIDER=resend',
    ),

    // Object storage (Supabase Storage / S3-compatible) — Session 03.
    STORAGE_ENDPOINT: required(source, 'STORAGE_ENDPOINT'),
    STORAGE_BUCKET: required(source, 'STORAGE_BUCKET'),
    STORAGE_ACCESS_KEY: required(source, 'STORAGE_ACCESS_KEY'),
    STORAGE_SECRET_KEY: required(source, 'STORAGE_SECRET_KEY'),

    // ─── Payments (Session 05) ──────────────────────────────────────────────
    // `PAYMENT_PROVIDER_PIX` / `_CRYPTO` / `_CARD` pick the adapter per channel;
    // they are read (and validated) in modules/payments/provider.factory.ts,
    // which crashes at boot on an unknown value rather than falling back.
    //
    // Woovi (OpenPix) — PIX. Required exactly when Woovi serves the PIX channel
    // (any environment): an active adapter without them fails at the first
    // charge; a disabled channel needs none (Session 13, D1).
    OPENPIX_APP_ID: requiredWhen(
      source,
      'OPENPIX_APP_ID',
      PROVIDERS.pix === 'woovi',
      'PAYMENT_PROVIDER_PIX=woovi',
    ),
    OPENPIX_WEBHOOK_SECRET: requiredWhen(
      source,
      'OPENPIX_WEBHOOK_SECRET',
      PROVIDERS.pix === 'woovi',
      'PAYMENT_PROVIDER_PIX=woovi',
    ),
    OPENPIX_API_URL: source.OPENPIX_API_URL ?? 'https://api.woovi.com',

    // NOWPayments — crypto. Same rule: required exactly when active.
    NOWPAYMENTS_API_KEY: requiredWhen(
      source,
      'NOWPAYMENTS_API_KEY',
      PROVIDERS.crypto === 'nowpayments',
      'PAYMENT_PROVIDER_CRYPTO=nowpayments',
    ),
    NOWPAYMENTS_IPN_SECRET: requiredWhen(
      source,
      'NOWPAYMENTS_IPN_SECRET',
      PROVIDERS.crypto === 'nowpayments',
      'PAYMENT_PROVIDER_CRYPTO=nowpayments',
    ),
    NOWPAYMENTS_API_URL: source.NOWPAYMENTS_API_URL ?? 'https://api.nowpayments.io',
    // Optional recurring-plan ids. When unset, a subscription checkout still
    // produces the first period's payment — only the provider-side recurrence
    // registration is skipped.
    NOWPAYMENTS_PLAN_ID_STANDARD: source.NOWPAYMENTS_PLAN_ID_STANDARD ?? '',
    NOWPAYMENTS_PLAN_ID_PREMIUM: source.NOWPAYMENTS_PLAN_ID_PREMIUM ?? '',

    API_PUBLIC_URL,

    // ─── Payouts (Session 06) ───────────────────────────────────────────────
    // `PAYOUT_PROVIDER` picks the adapter and is read (and validated) in
    // modules/payouts/provider.factory.ts, which crashes at boot on an unknown
    // value rather than falling back.
    //
    // Paxum — model payouts. Required exactly when Paxum is the active adapter.
    PAXUM_API_KEY: requiredWhen(
      source,
      'PAXUM_API_KEY',
      PROVIDERS.payout === 'paxum',
      'PAYOUT_PROVIDER=paxum',
    ),
    PAXUM_IPN_SECRET: requiredWhen(
      source,
      'PAXUM_IPN_SECRET',
      PROVIDERS.payout === 'paxum',
      'PAYOUT_PROVIDER=paxum',
    ),
    PAXUM_API_URL: source.PAXUM_API_URL ?? 'https://api.paxum.com',

    /**
     * Shared secret for POST /api/payouts/run. The caller is a scheduled job,
     * not a logged-in admin, so there is no JWT to present — see the route for
     * why. Required in production while payouts are enabled; with payouts
     * disabled the run answers 503 anyway, and a blank configured secret is a
     * 401 for every caller (the route never treats blank as open).
     */
    PAYOUT_CRON_SECRET: requiredWhen(
      source,
      'PAYOUT_CRON_SECRET',
      isProduction && PROVIDERS.payout !== 'disabled',
      'NODE_ENV=production with payouts enabled',
    ),

    /** Model's cut of a confirmed subscription payment, as a whole percent. */
    REVENUE_SHARE_MODEL_PCT: integerInRange(
      source,
      'REVENUE_SHARE_MODEL_PCT',
      DEFAULT_REVENUE_SHARE_MODEL_PCT,
      0,
      100,
    ),

    /** Minimum unpaid balance (minor units) a run will pay out. */
    PAYOUT_MIN_THRESHOLD_CENTS: integerInRange(
      source,
      'PAYOUT_MIN_THRESHOLD_CENTS',
      DEFAULT_PAYOUT_MIN_THRESHOLD_CENTS,
      1,
      100_000_000,
    ),

    /**
     * Currency Paxum settles payouts in. Earnings are summed in minor units
     * without FX conversion, so a deployment selling in more than one currency
     * needs the multi-currency work flagged in CLAUDE.md's Open Items first.
     */
    PAYOUT_CURRENCY: (source.PAYOUT_CURRENCY ?? 'BRL') as Currency,

    // ─── Subscription lifecycle (Session 06.5) ──────────────────────────────
    /**
     * Shared secret for POST /api/subscriptions/renewals/run, called by the daily
     * GitHub Actions cron job rather than a logged-in user — same reasoning as
     * PAYOUT_CRON_SECRET, and the same bar: required in production so an empty
     * value can never become an open endpoint, compared in constant time, and
     * never echoed into a response, log line, or error message.
     */
    SUBSCRIPTION_RENEWAL_CRON_SECRET: requiredInProduction(
      source,
      'SUBSCRIPTION_RENEWAL_CRON_SECRET',
      isProduction,
    ),

    /** Days before `currentPeriodEnd` that the renewal charge + reminder go out. */
    SUBSCRIPTION_RENEWAL_REMINDER_DAYS: integerInRange(
      source,
      'SUBSCRIPTION_RENEWAL_REMINDER_DAYS',
      DEFAULT_SUBSCRIPTION_RENEWAL_REMINDER_DAYS,
      1,
      28,
    ),

    /** Days a non-payer stays PAST_DUE after `currentPeriodEnd` before EXPIRED. */
    SUBSCRIPTION_GRACE_PERIOD_DAYS: integerInRange(
      source,
      'SUBSCRIPTION_GRACE_PERIOD_DAYS',
      DEFAULT_SUBSCRIPTION_GRACE_PERIOD_DAYS,
      0,
      28,
    ),

    // ─── AI generation (Session 08) ─────────────────────────────────────────
    // `AI_PROVIDER` picks the adapter (`replicate` | `mock` | `disabled`) and is
    // validated by `resolveProviderModes` above, which crashes on an unknown
    // value rather than falling back.
    //
    // The Replicate token is required whenever the Replicate adapter is the one
    // selected — in every environment, not only production. A missing token
    // would otherwise surface as a 502 after a subscriber's credits were already
    // debited (and then refunded), which is a worse failure than not booting.
    AI_PROVIDER_API_KEY: requiredWhen(
      source,
      'AI_PROVIDER_API_KEY',
      PROVIDERS.ai === 'replicate',
      'AI_PROVIDER=replicate',
    ),

    /**
     * Wall-clock budget for one synchronous generation, provider call included.
     * The request holds a connection open for this long at most; past it the
     * prediction is cancelled, the job is FAILED and the credits are refunded.
     */
    GENERATION_TIMEOUT_MS,

    /** Days a completed image stays servable before `expiresAt` cuts it off. */
    GENERATION_IMAGE_RETENTION_DAYS: integerInRange(
      source,
      'GENERATION_IMAGE_RETENTION_DAYS',
      DEFAULT_GENERATION_IMAGE_RETENTION_DAYS,
      1,
      365,
    ),

    // ─── Anti-leak & content protection (Session 09) ───────────────────────
    /**
     * HMAC key behind the per-viewer forensic trace code burned into every
     * served image (and returned alongside every served video). Required in
     * EVERY environment, exactly like JWT_SECRET: a serve path with no key would
     * have to either skip the trace (an untraceable leak) or fall back to a
     * hard-coded one (a forgeable trace), and both are worse than not booting.
     * Min 32 chars — see `requiredMinLength`. Never logged, never echoed.
     */
    WATERMARK_TRACE_SECRET: requiredMinLength(source, 'WATERMARK_TRACE_SECRET', 32),

    /**
     * Shared secret for POST /api/admin/storage/cleanup/run, called by the daily
     * GitHub Actions cron job — identical posture to PAYOUT_CRON_SECRET and
     * SUBSCRIPTION_RENEWAL_CRON_SECRET: required in production so an empty value
     * can never become an open endpoint, compared in constant time, never echoed.
     */
    STORAGE_CLEANUP_CRON_SECRET: requiredInProduction(
      source,
      'STORAGE_CLEANUP_CRON_SECRET',
      isProduction,
    ),

    TRUST_PROXY,

    /**
     * Shared secret for POST /api/admin/reconciliation/run, called by the daily
     * GitHub Actions cron job — the same posture as the other cron secrets:
     * required in production, compared in constant time, never echoed.
     */
    RECONCILIATION_CRON_SECRET: requiredInProduction(
      source,
      'RECONCILIATION_CRON_SECRET',
      isProduction,
    ),

    /** PENDING generations older than this are refunded + FAILED by the sweep. */
    GENERATION_STALE_AFTER_MS,

    /** PENDING/PROCESSING payouts older than this are flagged (never resolved). */
    PAYOUT_STALE_AFTER_HOURS: integerInRange(
      source,
      'PAYOUT_STALE_AFTER_HOURS',
      DEFAULT_PAYOUT_STALE_AFTER_HOURS,
      1,
      24 * 90,
    ),

    /**
     * Largest accepted upload, in bytes (content and message attachments).
     * Uploads are buffered whole before the storage write, and a buffered body
     * can transiently exist twice (multipart chunks + the concatenated Buffer),
     * so the worst case for one upload is ~2× this, off the V8 heap. Against
     * the API container's 448 MiB limit: ~256 MiB heap ceiling + ~60 MiB for
     * the Prisma engine, sharp/libvips and runtime, leaves ~130 MiB — one
     * 64 MiB upload (~128 MiB peak) fits. The ceiling (96 MiB) is the most the
     * container survives only because the heap is rarely at its cap; anything
     * larger needs streaming multipart first (Open Item). Caddy's
     * `request_body max_size` is this plus a small margin.
     */
    CONTENT_UPLOAD_MAX_BYTES: integerInRange(
      source,
      'CONTENT_UPLOAD_MAX_BYTES',
      DEFAULT_CONTENT_UPLOAD_MAX_BYTES,
      1 * MIB,
      CONTENT_UPLOAD_HARD_CEILING_BYTES,
    ),

    // ─── Error monitoring (Session 13, D3) ─────────────────────────────────
    /** Unset = Sentry is never initialised (tests, local dev). Not a secret, but not public either. */
    SENTRY_DSN: (source.SENTRY_DSN ?? '').trim(),
    SENTRY_ENVIRONMENT: (source.SENTRY_ENVIRONMENT ?? '').trim() || NODE_ENV,
    /** The git SHA the image was built from (Dockerfile build arg → env). */
    SENTRY_RELEASE: (source.SENTRY_RELEASE ?? '').trim(),
    /** Performance tracing is off unless asked for: errors only by default. */
    SENTRY_TRACES_SAMPLE_RATE: fraction(source, 'SENTRY_TRACES_SAMPLE_RATE', 0),

    // Tunables with safe defaults.
    JWT_EXPIRES_IN: source.JWT_EXPIRES_IN ?? '15m',
    JWT_REFRESH_EXPIRES_IN: source.JWT_REFRESH_EXPIRES_IN ?? '7d',
    EMAIL_FROM: source.EMAIL_FROM ?? 'noreply@example.com',
    APP_URL,
    // S3 signing needs a region string even for region-less providers (Supabase
    // Storage / R2); the value only affects the SigV4 signature, not routing.
    STORAGE_REGION: source.STORAGE_REGION ?? 'us-east-1',
  } as const;
}

export const env = loadEnv(process.env);

export type Env = ReturnType<typeof loadEnv>;

// Cookie lifetimes in seconds, derived from the token TTLs above.
export const ACCESS_COOKIE_MAX_AGE = 15 * 60; // 15 minutes
export const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days
