// =============================================================================
// Route security inventory (Session 12, D3).
//
// Builds the real server (with test fakes), lets every plugin load, and checks
// every registered route against the policy in `route-policy.ts`:
//
//   * authenticated, or listed in PUBLIC_ROUTES with a reason;
//   * rate-limited,  or listed in UNLIMITED_ROUTES with a reason;
//   * and every allowlist entry still names a real route that actually needs
//     the exception — so the lists cannot silently go stale.
//
// Failures name the offending `METHOD /url`, so the fix is obvious.
// =============================================================================
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../index.js';
import type { PrismaClient } from '../lib/prisma.js';
import type { StorageClient } from '../lib/storage.js';
import type { ImageProcessor } from '../lib/image.js';
import { createFakeEmailer, createFakePrisma } from '../test/fake-prisma.js';
import type { RouteInventoryEntry } from './route-inventory.js';
import { PUBLIC_ROUTES, UNLIMITED_ROUTES } from './route-policy.js';

const fakeStorage: StorageClient = {
  uploadFile: vi.fn(async (_b: string, key: string) => key),
  getSignedUrl: vi.fn(async () => 'https://signed.example/x'),
  getObject: vi.fn(async () => Buffer.from('RAW')),
  deleteFile: vi.fn(async () => {}),
};
const fakeImages: ImageProcessor = {
  getDimensions: vi.fn(async () => ({ width: 1, height: 1 })),
  watermark: vi.fn(async () => Buffer.from('WATERMARKED')),
};

const keyOf = (entry: RouteInventoryEntry) => `${entry.method} ${entry.url}`;

let inventory: RouteInventoryEntry[];

beforeAll(async () => {
  const app = await buildServer({
    prisma: createFakePrisma() as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage: fakeStorage,
    images: fakeImages,
  });
  await app.ready();
  inventory = [...app.routeInventory];
  await app.close();
});

describe('route security inventory', () => {
  it('sees the whole API (sanity: the collector is actually wired)', () => {
    const keys = inventory.map(keyOf);
    expect(keys.length).toBeGreaterThan(50);
    // One route from each auth style the collector must understand:
    // route-level preHandler, plugin-scoped hook, WebSocket preValidation.
    expect(inventory.find((e) => keyOf(e) === 'GET /api/wallet/balance')?.authenticated).toBe(true);
    expect(inventory.find((e) => keyOf(e) === 'GET /api/admin/users')?.authenticated).toBe(true);
    expect(inventory.find((e) => keyOf(e) === 'GET /ws/messages')?.authenticated).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every route is authenticated or explicitly public', () => {
    const offenders = inventory
      .filter((entry) => !entry.authenticated && !(keyOf(entry) in PUBLIC_ROUTES))
      .map(keyOf);
    expect(offenders, `unauthenticated and not in PUBLIC_ROUTES: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });

  it('every route is rate-limited or explicitly unlimited', () => {
    const offenders = inventory
      .filter((entry) => !entry.rateLimited && !(keyOf(entry) in UNLIMITED_ROUTES))
      .map(keyOf);
    expect(offenders, `no rate limit and not in UNLIMITED_ROUTES: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });

  it('every PUBLIC_ROUTES entry is a real route that really is unauthenticated', () => {
    const byKey = new Map(inventory.map((entry) => [keyOf(entry), entry]));
    const stale = Object.keys(PUBLIC_ROUTES).filter((key) => {
      const entry = byKey.get(key);
      return !entry || entry.authenticated;
    });
    expect(stale, `stale PUBLIC_ROUTES entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('every UNLIMITED_ROUTES entry is a real route that really has no limit', () => {
    const byKey = new Map(inventory.map((entry) => [keyOf(entry), entry]));
    const stale = Object.keys(UNLIMITED_ROUTES).filter((key) => {
      const entry = byKey.get(key);
      return !entry || entry.rateLimited;
    });
    expect(stale, `stale UNLIMITED_ROUTES entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    for (const reason of [...Object.values(PUBLIC_ROUTES), ...Object.values(UNLIMITED_ROUTES)]) {
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });
});
