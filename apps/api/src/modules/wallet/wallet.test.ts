// Credit wallet unit + integration tests.
//
// The interesting property is the one the AI-generation flow (Session 08) will
// depend on: an under-funded debit must fail *without* mutating anything. It is
// tested against a fake that enforces the same `balance >= amount` guard the
// real conditional UPDATE does, so the assertion is about the query shape, not
// about JavaScript arithmetic.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import {
  createFakeEmailer,
  createFakePrisma,
  seedWallet,
  type FakePrisma,
} from '../../test/fake-prisma.js';
import {
  createWalletService,
  InsufficientCreditsError,
  InvalidCreditAmountError,
} from './wallet.service.js';

function makeService(prisma: FakePrisma) {
  return createWalletService({ prisma: prisma as unknown as PrismaClient });
}

// ── Unit: addCredits / debitCredits ──────────────────────────────────────────
describe('walletService.addCredits', () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = createFakePrisma();
  });

  it('creates the wallet on first credit and audits it', async () => {
    const service = makeService(prisma);
    const balance = await service.addCredits('u_1', 100, { reason: 'credit_pack_purchase' });

    expect(balance).toBe(100);
    expect(prisma.__wallets).toHaveLength(1);
    const log = prisma.__auditLogs.find((l) => l.action === 'wallet.credited')!;
    expect(log).toBeDefined();
    expect(log.metadata).toMatchObject({ userId: 'u_1', amount: 100, balanceAfter: 100 });
  });

  it('increments an existing balance', async () => {
    seedWallet(prisma, 'u_1', 40);
    const service = makeService(prisma);

    await service.addCredits('u_1', 60, { reason: 'credit_pack_purchase' });

    expect(await service.getBalance('u_1')).toBe(100);
    expect(prisma.__wallets).toHaveLength(1);
  });

  it('rejects a non-positive or fractional amount', async () => {
    const service = makeService(prisma);
    await expect(service.addCredits('u_1', 0, { reason: 'x' })).rejects.toBeInstanceOf(
      InvalidCreditAmountError,
    );
    await expect(service.addCredits('u_1', -5, { reason: 'x' })).rejects.toBeInstanceOf(
      InvalidCreditAmountError,
    );
    await expect(service.addCredits('u_1', 1.5, { reason: 'x' })).rejects.toBeInstanceOf(
      InvalidCreditAmountError,
    );
    expect(prisma.__wallets).toHaveLength(0);
  });
});

describe('walletService.debitCredits', () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = createFakePrisma();
  });

  it('spends credits and audits the debit', async () => {
    seedWallet(prisma, 'u_1', 100);
    const service = makeService(prisma);

    const balance = await service.debitCredits('u_1', 30, { reason: 'ai_generation' });

    expect(balance).toBe(70);
    expect(prisma.__wallets[0].balance).toBe(70);
    expect(prisma.__auditLogs.some((l) => l.action === 'wallet.debited')).toBe(true);
  });

  it('spends the entire balance down to exactly zero', async () => {
    seedWallet(prisma, 'u_1', 25);
    const service = makeService(prisma);

    expect(await service.debitCredits('u_1', 25, { reason: 'ai_generation' })).toBe(0);
  });

  it('rejects an under-funded debit with no partial mutation', async () => {
    seedWallet(prisma, 'u_1', 10);
    const service = makeService(prisma);

    await expect(
      service.debitCredits('u_1', 11, { reason: 'ai_generation' }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    // Balance untouched, and no audit row — nothing happened.
    expect(prisma.__wallets[0].balance).toBe(10);
    expect(prisma.__auditLogs.filter((l) => l.action === 'wallet.debited')).toHaveLength(0);
  });

  it('reports the requested and available amounts on rejection', async () => {
    seedWallet(prisma, 'u_1', 10);
    const service = makeService(prisma);

    await expect(service.debitCredits('u_1', 40)).rejects.toMatchObject({
      status: 402,
      requested: 40,
      available: 10,
    });
  });

  it('rejects a debit against a wallet that does not exist', async () => {
    const service = makeService(prisma);
    await expect(service.debitCredits('u_nobody', 1)).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    expect(prisma.__wallets).toHaveLength(0);
  });
});

describe('walletService.getBalance', () => {
  it('reads 0 for a user who has never transacted', async () => {
    const prisma = createFakePrisma();
    expect(await makeService(prisma).getBalance('u_new')).toBe(0);
  });
});

// ── Integration: GET /api/wallet/balance ─────────────────────────────────────
describe('GET /api/wallet/balance', () => {
  let prisma: FakePrisma;
  let app: Awaited<ReturnType<typeof buildServer>>;

  const storage: StorageClient = {
    uploadFile: vi.fn(async (_bucket: string, key: string) => key),
    getSignedUrl: vi.fn(async () => 'https://signed.example/x'),
    getObject: vi.fn(async () => Buffer.from('RAW')),
    deleteFile: vi.fn(async () => {}),
  };
  const images: ImageProcessor = {
    getDimensions: vi.fn(async () => ({ width: 1, height: 1 })),
    watermark: vi.fn(async (buffer: Buffer) => buffer),
  };

  async function loginAs(email: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'supersecret', displayName: 'Sub', role: 'subscriber' },
    });
    const token = prisma.__users.find((u) => u.email === email)!.verifyToken!;
    await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}` });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'supersecret' },
    });
    return login.cookies.find((c) => c.name === 'access_token')!.value;
  }

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await buildServer({
      prisma: prisma as unknown as PrismaClient,
      emailer: createFakeEmailer(),
      storage,
      images,
    });
  });

  it("returns the caller's own balance", async () => {
    const cookie = await loginAs('sub@example.com');
    const userId = prisma.__users.find((u) => u.email === 'sub@example.com')!.id;
    seedWallet(prisma, userId, 250);

    const res = await app.inject({
      method: 'GET',
      url: '/api/wallet/balance',
      cookies: { access_token: cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId, balance: 250 });
  });

  it('returns 0 before any purchase', async () => {
    const cookie = await loginAs('sub@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/wallet/balance',
      cookies: { access_token: cookie },
    });
    expect(res.json().balance).toBe(0);
  });

  it("never exposes another user's balance — the id comes from the JWT", async () => {
    const cookie = await loginAs('sub@example.com');
    const otherId = 'u_someone_else';
    seedWallet(prisma, otherId, 9999);

    const res = await app.inject({
      method: 'GET',
      url: `/api/wallet/balance?userId=${otherId}`,
      cookies: { access_token: cookie },
    });

    expect(res.json().userId).not.toBe(otherId);
    expect(res.json().balance).toBe(0);
  });

  it('rejects an unauthenticated request → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/wallet/balance' });
    expect(res.statusCode).toBe(401);
  });
});
