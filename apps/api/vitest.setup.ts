// Runs before any test module is imported. Forces the test environment and
// provides the secrets that src/lib/env.ts validates eagerly at import time, so
// tests never touch the real .env, the real DB, or the real email provider.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long!!';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long!';
process.env.EMAIL_API_KEY ??= 're_test_key';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.EMAIL_FROM ??= 'noreply@test.local';
// A syntactically valid (but unused) connection string for PrismaClient ctor.
process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/testdb';
