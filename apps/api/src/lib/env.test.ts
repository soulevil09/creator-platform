// =============================================================================
// Boot-time configuration rules (Session 13, D2).
//
// `loadEnv` is the whole boot gate for configuration, and it is pure: each test
// hands it a plain object, so no test mutates `process.env` or resets modules.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  CONTENT_UPLOAD_HARD_CEILING_BYTES,
  DEFAULT_CONTENT_UPLOAD_MAX_BYTES,
  loadEnv,
  type EnvSource,
} from './env.js';

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(32);

/** Everything a non-production boot needs. */
function devSource(overrides: EnvSource = {}): EnvSource {
  return {
    NODE_ENV: 'development',
    JWT_SECRET: SECRET_A,
    JWT_REFRESH_SECRET: SECRET_B,
    EMAIL_API_KEY: 're_test',
    STORAGE_ENDPOINT: 'http://storage.test',
    STORAGE_BUCKET: 'bucket',
    STORAGE_ACCESS_KEY: 'ak',
    STORAGE_SECRET_KEY: 'sk',
    WATERMARK_TRACE_SECRET: 'w'.repeat(32),
    AI_PROVIDER: 'mock',
    ...overrides,
  };
}

/** A production boot that satisfies every rule; tests knock one out at a time. */
function prodSource(overrides: EnvSource = {}): EnvSource {
  return devSource({
    NODE_ENV: 'production',
    AI_PROVIDER: 'replicate',
    AI_PROVIDER_API_KEY: 'r8_x',
    APP_URL: 'https://app.visorfans.com',
    API_PUBLIC_URL: 'https://api.visorfans.com',
    TRUST_PROXY: '172.30.0.0/24',
    OPENPIX_APP_ID: 'x',
    OPENPIX_WEBHOOK_SECRET: 'x',
    NOWPAYMENTS_API_KEY: 'x',
    NOWPAYMENTS_IPN_SECRET: 'x',
    PAXUM_API_KEY: 'x',
    PAXUM_IPN_SECRET: 'x',
    PAYOUT_CRON_SECRET: 'x',
    SUBSCRIPTION_RENEWAL_CRON_SECRET: 'x',
    STORAGE_CLEANUP_CRON_SECRET: 'x',
    RECONCILIATION_CRON_SECRET: 'x',
    ...overrides,
  });
}

describe('D2 — JWT secrets', () => {
  it('boots with two distinct secrets of at least 32 characters', () => {
    expect(loadEnv(devSource()).JWT_SECRET).toBe(SECRET_A);
  });

  it.each(['JWT_SECRET', 'JWT_REFRESH_SECRET'])('%s shorter than 32 characters crashes', (name) => {
    expect(() => loadEnv(devSource({ [name]: 'x'.repeat(31) }))).toThrow(
      new RegExp(`${name} must be at least 32 characters`),
    );
  });

  it.each(['JWT_SECRET', 'JWT_REFRESH_SECRET'])('%s missing crashes', (name) => {
    expect(() => loadEnv(devSource({ [name]: undefined }))).toThrow(new RegExp(name));
  });

  it('identical access and refresh secrets crash', () => {
    expect(() => loadEnv(devSource({ JWT_REFRESH_SECRET: SECRET_A }))).toThrow(/must be different/);
  });
});

describe('D2 — production URLs', () => {
  it('a fully configured production boot succeeds', () => {
    const env = loadEnv(prodSource());
    expect(env.isProduction).toBe(true);
    expect(env.TRUST_PROXY).toEqual(['172.30.0.0/24']);
  });

  it.each(['APP_URL', 'API_PUBLIC_URL'])('%s missing in production crashes', (name) => {
    expect(() => loadEnv(prodSource({ [name]: undefined }))).toThrow(new RegExp(name));
  });

  it.each([
    ['APP_URL', 'http://app.visorfans.com'],
    ['API_PUBLIC_URL', 'http://api.visorfans.com'],
  ])('%s over plain http in production crashes', (name, value) => {
    expect(() => loadEnv(prodSource({ [name]: value }))).toThrow(/must be an https:\/\/ URL/);
  });

  it('web and API on different registrable domains crash', () => {
    expect(() =>
      loadEnv(prodSource({ API_PUBLIC_URL: 'https://visorfans-api.up.railway.app' })),
    ).toThrow(/share one registrable domain/);
  });

  it('a malformed URL crashes without echoing anything but the value', () => {
    expect(() => loadEnv(prodSource({ APP_URL: 'not a url' }))).toThrow(/not a valid URL/);
  });

  it('the same rules do not apply outside production', () => {
    expect(() =>
      loadEnv(devSource({ APP_URL: 'http://localhost:3000', API_PUBLIC_URL: 'http://x.test' })),
    ).not.toThrow();
  });
});

describe('D2 — production TRUST_PROXY', () => {
  it.each([undefined, '', 'false', '0'])('TRUST_PROXY=%s in production crashes', (value) => {
    expect(() => loadEnv(prodSource({ TRUST_PROXY: value }))).toThrow(/TRUST_PROXY must be set/);
  });

  it('a hop count crashes in every environment', () => {
    expect(() => loadEnv(prodSource({ TRUST_PROXY: '1' }))).toThrow(/hop count/);
    expect(() => loadEnv(devSource({ TRUST_PROXY: '1' }))).toThrow(/hop count/);
  });

  it('unset is fine outside production', () => {
    expect(loadEnv(devSource()).TRUST_PROXY).toBe(false);
  });
});

describe('D2 — production cron secrets', () => {
  it.each([
    'SUBSCRIPTION_RENEWAL_CRON_SECRET',
    'STORAGE_CLEANUP_CRON_SECRET',
    'RECONCILIATION_CRON_SECRET',
  ])('%s missing in production crashes', (name) => {
    expect(() => loadEnv(prodSource({ [name]: undefined }))).toThrow(new RegExp(name));
  });

  it('WATERMARK_TRACE_SECRET is still required (min 32) everywhere', () => {
    expect(() => loadEnv(devSource({ WATERMARK_TRACE_SECRET: 'short' }))).toThrow(
      /WATERMARK_TRACE_SECRET must be at least 32/,
    );
  });
});

describe('Session 13 — CONTENT_UPLOAD_MAX_BYTES', () => {
  it('defaults to 64 MiB', () => {
    expect(loadEnv(devSource()).CONTENT_UPLOAD_MAX_BYTES).toBe(DEFAULT_CONTENT_UPLOAD_MAX_BYTES);
    expect(DEFAULT_CONTENT_UPLOAD_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('accepts a value up to the hard ceiling', () => {
    expect(
      loadEnv(devSource({ CONTENT_UPLOAD_MAX_BYTES: String(CONTENT_UPLOAD_HARD_CEILING_BYTES) }))
        .CONTENT_UPLOAD_MAX_BYTES,
    ).toBe(CONTENT_UPLOAD_HARD_CEILING_BYTES);
  });

  it('crashes above the ceiling the API container can absorb', () => {
    expect(() =>
      loadEnv(
        devSource({ CONTENT_UPLOAD_MAX_BYTES: String(CONTENT_UPLOAD_HARD_CEILING_BYTES + 1) }),
      ),
    ).toThrow(/CONTENT_UPLOAD_MAX_BYTES/);
    expect(() =>
      loadEnv(devSource({ CONTENT_UPLOAD_MAX_BYTES: String(500 * 1024 * 1024) })),
    ).toThrow(/CONTENT_UPLOAD_MAX_BYTES/);
  });
});
