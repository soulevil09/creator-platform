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
