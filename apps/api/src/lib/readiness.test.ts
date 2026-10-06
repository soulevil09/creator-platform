// =============================================================================
// Liveness vs readiness (Session 13, D5).
// =============================================================================
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../index.js';
import type { PrismaClient } from './prisma.js';
import { createFakeEmailer, createFakePrisma } from '../test/fake-prisma.js';
import { databaseReady } from './readiness.js';

const storage = {
  uploadFile: vi.fn(async (_b: string, key: string) => key),
  getSignedUrl: vi.fn(async () => 'https://signed.example/x'),
  getObject: vi.fn(async () => Buffer.from('RAW')),
  deleteFile: vi.fn(async () => {}),
};
const images = {
  getDimensions: vi.fn(async () => ({ width: 1, height: 1 })),
  watermark: vi.fn(async (b: Buffer) => b),
};

/** The fake client plus a controllable `$queryRaw`. */
async function appWithDb(queryRaw: () => Promise<unknown>) {
  const prisma = Object.assign(createFakePrisma(), { $queryRaw: vi.fn(queryRaw) });
  const app = await buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage,
    images,
  });
  return { app, queryRaw: prisma.$queryRaw };
}

describe('databaseReady', () => {
  it('true when SELECT 1 resolves', async () => {
    expect(await databaseReady({ $queryRaw: async () => [{ '?column?': 1 }] })).toBe(true);
  });

  it('false when the query throws', async () => {
    expect(
      await databaseReady({
        $queryRaw: async () => {
          throw new Error('connect ECONNREFUSED db.internal:5432');
        },
      }),
    ).toBe(false);
  });

  it('false when the query outlives the timeout', async () => {
    const never = { $queryRaw: () => new Promise(() => {}) };
    expect(await databaseReady(never, 20)).toBe(false);
  });
});

describe('GET /health/ready', () => {
  it('200 { status: ok } when the database answers', async () => {
    const { app, queryRaw } = await appWithDb(async () => [{ '?column?': 1 }]);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('503 { status: unavailable } — and nothing about why — when it does not', async () => {
    const { app } = await appWithDb(async () => {
      throw new Error('connect ECONNREFUSED aws-0-us-east-2.pooler.supabase.com:6543');
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    expect(res.body).not.toMatch(/supabase|ECONNREFUSED|6543/);
  });

  it('is IP rate-limited', async () => {
    const { app } = await appWithDb(async () => [1]);
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      codes.push((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode);
    }
    expect(codes.slice(0, 30).every((code) => code === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it('GET /health stays liveness: no database call at all', async () => {
    const { app, queryRaw } = await appWithDb(async () => [1]);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
