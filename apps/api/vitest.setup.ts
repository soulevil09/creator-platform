// Runs before any test module is imported. Forces the test environment and
// provides the secrets that src/lib/env.ts validates eagerly at import time, so
// tests never touch the real .env, the real DB, or the real email provider.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long!!';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long!';
process.env.EMAIL_API_KEY ??= 're_test_key';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.EMAIL_FROM ??= 'noreply@test.local';
// Storage secrets validated eagerly by src/lib/env.ts. Tests inject an
// in-memory StorageClient fake, so these never reach a real bucket.
process.env.STORAGE_ENDPOINT ??= 'http://localhost:54321/storage/v1/s3';
process.env.STORAGE_BUCKET ??= 'test-bucket';
process.env.STORAGE_ACCESS_KEY ??= 'test-access-key';
process.env.STORAGE_SECRET_KEY ??= 'test-secret-key';
// A syntactically valid (but unused) connection string for PrismaClient ctor.
process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/testdb';

// Payment provider credentials (Session 05). Deterministic fakes: every adapter
// test runs against nock-intercepted HTTP or a stub adapter, so these never
// reach Woovi or NOWPayments. The API base URLs point at hosts that only exist
// inside nock's interceptor table — an un-mocked call fails loudly instead of
// escaping to the internet.
process.env.PAYMENT_PROVIDER_PIX ??= 'woovi';
process.env.PAYMENT_PROVIDER_CRYPTO ??= 'nowpayments';
process.env.PAYMENT_PROVIDER_CARD ??= 'mock';
process.env.OPENPIX_APP_ID ??= 'test-openpix-app-id';
process.env.OPENPIX_WEBHOOK_SECRET ??= 'test-openpix-webhook-secret';
process.env.OPENPIX_API_URL ??= 'https://woovi.test';
process.env.NOWPAYMENTS_API_KEY ??= 'test-nowpayments-api-key';
process.env.NOWPAYMENTS_IPN_SECRET ??= 'test-nowpayments-ipn-secret';
process.env.NOWPAYMENTS_API_URL ??= 'https://nowpayments.test';
process.env.API_PUBLIC_URL ??= 'http://localhost:4000';
