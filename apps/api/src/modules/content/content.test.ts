// Content management integration tests.
//
// Same philosophy as the auth/onboarding suites: NO real database, storage, or
// image library. We inject an in-memory Prisma fake, a fake StorageClient, and
// a fake ImageProcessor into buildServer() and drive the HTTP layer with
// Fastify's `inject`. Auth cookies come from the real register→verify→login
// flow against the same fake DB, so RBAC is exercised end-to-end.
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { Emailer } from '../../lib/email.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';

// ── In-memory fakes ──────────────────────────────────────────────────────────
interface FakeUser {
  id: string;
  email: string;
  passwordHash: string;
  role: 'ADMIN' | 'MODEL' | 'SUBSCRIBER';
  displayName: string;
  isVerified: boolean;
  verifyToken: string | null;
  verifyTokenExpiresAt: Date | null;
  refreshTokenHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeProfile {
  id: string;
  userId: string;
}

interface FakeContent {
  id: string;
  modelId: string;
  title: string;
  description: string | null;
  type: 'IMAGE' | 'VIDEO';
  tier: 'FREE' | 'STANDARD' | 'PREMIUM';
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSecs: number | null;
  isPublished: boolean;
  ppvPriceCents: number | null;
  viewCount: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeAccess {
  id: string;
  contentId: string;
  userId: string;
  grantReason: string;
  grantedAt: Date;
  expiresAt: Date | null;
}

type Where = Record<string, unknown>;

function createFakePrisma() {
  const users: FakeUser[] = [];
  const profiles: FakeProfile[] = [];
  const content: FakeContent[] = [];
  const accesses: FakeAccess[] = [];
  let seq = 0;

  const matchUser = (u: FakeUser, where: Where) =>
    (where.id !== undefined && u.id === where.id) ||
    (where.email !== undefined && u.email === where.email) ||
    (where.verifyToken !== undefined && u.verifyToken === where.verifyToken);

  const client = {
    user: {
      findUnique: async ({ where }: { where: Where }) =>
        users.find((u) => matchUser(u, where)) ?? null,
      create: async ({ data }: { data: Partial<FakeUser> }) => {
        const now = new Date();
        const user = {
          refreshTokenHash: null,
          verifyToken: null,
          verifyTokenExpiresAt: null,
          isVerified: false,
          ...data,
          id: `u_${++seq}`,
          createdAt: now,
          updatedAt: now,
        } as FakeUser;
        users.push(user);
        return user;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error('record not found');
        Object.assign(user, data, { updatedAt: new Date() });
        return user;
      },
    },

    modelProfile: {
      findUnique: async ({ where }: { where: Where }) =>
        profiles.find(
          (p) =>
            (where.userId !== undefined && p.userId === where.userId) ||
            (where.id !== undefined && p.id === where.id),
        ) ?? null,
    },

    content: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        content.find((c) => c.id === where.id) ?? null,
      findMany: async ({ where, orderBy }: { where: Where; orderBy?: Where }) => {
        let rows = content.filter((c) => {
          if (where.modelId !== undefined && c.modelId !== where.modelId) return false;
          if (where.deletedAt === null && c.deletedAt !== null) return false;
          if (where.isPublished !== undefined && c.isPublished !== where.isPublished) return false;
          if (where.type !== undefined && c.type !== where.type) return false;
          if (where.tier !== undefined && c.tier !== where.tier) return false;
          return true;
        });
        if ((orderBy as { createdAt?: string })?.createdAt === 'desc') {
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return rows;
      },
      create: async ({ data }: { data: Partial<FakeContent> & { modelId: string } }) => {
        const now = new Date(Date.now() + ++seq);
        const row = {
          description: null,
          tier: 'STANDARD',
          width: null,
          height: null,
          durationSecs: null,
          isPublished: false,
          ppvPriceCents: null,
          viewCount: 0,
          deletedAt: null,
          ...data,
          id: `c_${seq}`,
          createdAt: now,
          updatedAt: now,
        } as FakeContent;
        content.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = content.find((c) => c.id === where.id);
        if (!row) throw new Error('record not found');
        // Support the fire-and-forget { viewCount: { increment: 1 } } shape.
        const inc = (data.viewCount as { increment?: number } | undefined)?.increment;
        if (inc !== undefined) {
          row.viewCount += inc;
          delete (data as Record<string, unknown>).viewCount;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },

    contentAccess: {
      findUnique: async ({ where }: { where: Where }) => {
        const composite = where.contentId_userId as
          | { contentId: string; userId: string }
          | undefined;
        if (!composite) return null;
        return (
          accesses.find(
            (a) => a.contentId === composite.contentId && a.userId === composite.userId,
          ) ?? null
        );
      },
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: Where;
        update: Partial<FakeAccess>;
        create: Partial<FakeAccess> & { contentId: string; userId: string };
      }) => {
        const composite = where.contentId_userId as { contentId: string; userId: string };
        const existing = accesses.find(
          (a) => a.contentId === composite.contentId && a.userId === composite.userId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = {
          grantReason: 'unknown',
          grantedAt: new Date(),
          expiresAt: null,
          ...create,
          id: `a_${++seq}`,
        } as FakeAccess;
        accesses.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { contentId: string; userId: string } }) => {
        let count = 0;
        for (let i = accesses.length - 1; i >= 0; i--) {
          if (accesses[i].contentId === where.contentId && accesses[i].userId === where.userId) {
            accesses.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },

    __users: users,
    __profiles: profiles,
    __content: content,
    __accesses: accesses,
  };
  return client;
}

type FakePrisma = ReturnType<typeof createFakePrisma>;

function createFakeEmailer(): Emailer {
  return { sendVerificationEmail: vi.fn(async () => {}) };
}

function createFakeStorage() {
  const uploaded = new Map<string, { bucket: string; mimeType: string; size: number }>();
  const storage: StorageClient = {
    uploadFile: vi.fn(async (bucket: string, key: string, buffer: Buffer, mimeType: string) => {
      uploaded.set(key, { bucket, mimeType, size: buffer.length });
      return key;
    }),
    getSignedUrl: vi.fn(
      async (_bucket: string, key: string, ttl: number) =>
        `https://signed.example/${key}?ttl=${ttl}`,
    ),
    getObject: vi.fn(async (_bucket: string, _key: string) => Buffer.from('RAW-IMAGE-BYTES')),
    deleteFile: vi.fn(async () => {}),
  };
  return { storage, uploaded };
}

const WATERMARK_MARKER = 'WATERMARKED-BYTES';

function createFakeImages() {
  const images: ImageProcessor = {
    getDimensions: vi.fn(async () => ({ width: 800, height: 600 })),
    watermark: vi.fn(async (_buffer: Buffer, label: string) =>
      Buffer.from(`${WATERMARK_MARKER}:${label}`),
    ),
  };
  return images;
}

async function makeApp(prisma: FakePrisma, storage: StorageClient, images: ImageProcessor) {
  return buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage,
    images,
  });
}

type App = Awaited<ReturnType<typeof makeApp>>;

/** Run register→verify→login for a role; return its access_token cookie value. */
async function loginAs(
  app: App,
  prisma: FakePrisma,
  role: 'model' | 'subscriber',
  email: string,
): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'supersecret', displayName: 'Test User', role },
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

const userIdFor = (prisma: FakePrisma, email: string) =>
  prisma.__users.find((u) => u.email === email)!.id;

/** Seed a ModelProfile so uploads pass the "profile required" gate. */
function seedProfile(prisma: FakePrisma, userId: string) {
  prisma.__profiles.push({ id: `mp_${userId}`, userId });
}

/** Seed a Content row directly (faster than uploading for non-upload tests). */
function seedContent(prisma: FakePrisma, overrides: Partial<FakeContent> & { modelId: string }) {
  const n = prisma.__content.length + 1;
  const row: FakeContent = {
    id: `c_seed_${n}`,
    title: 'Seeded',
    description: null,
    type: 'IMAGE',
    tier: 'STANDARD',
    storageKey: `content/${overrides.modelId}/seed_${n}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: 1234,
    width: 800,
    height: 600,
    durationSecs: null,
    isPublished: true,
    ppvPriceCents: null,
    viewCount: 0,
    deletedAt: null,
    createdAt: new Date(Date.now() + n),
    updatedAt: new Date(Date.now() + n),
    ...overrides,
  };
  prisma.__content.push(row);
  return row;
}

function grantAccess(
  prisma: FakePrisma,
  contentId: string,
  userId: string,
  grantReason: string,
  expiresAt: Date | null = null,
) {
  prisma.__accesses.push({
    id: `a_seed_${prisma.__accesses.length + 1}`,
    contentId,
    userId,
    grantReason,
    grantedAt: new Date(),
    expiresAt,
  });
}

// Minimal but valid magic-byte signatures for file-type sniffing.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

/** Build a multipart/form-data body with metadata fields + a single file. */
function multipartUpload(opts: {
  fields: Record<string, string>;
  file?: { content: Buffer; contentType: string; field?: string; filename?: string };
}) {
  const boundary = `----cpb${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(opts.fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  if (opts.file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${opts.file.field ?? 'file'}"; ` +
          `filename="${opts.file.filename ?? 'upload.bin'}"\r\n` +
          `Content-Type: ${opts.file.contentType}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(opts.file.content);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// ── Upload ───────────────────────────────────────────────────────────────────
describe('POST /api/content/upload', () => {
  let prisma: FakePrisma;
  let storageBundle: ReturnType<typeof createFakeStorage>;
  let app: App;
  let cookie: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    storageBundle = createFakeStorage();
    app = await makeApp(prisma, storageBundle.storage, createFakeImages());
    cookie = await loginAs(app, prisma, 'model', 'model@example.com');
    seedProfile(prisma, userIdFor(prisma, 'model@example.com'));
  });

  const upload = (body: ReturnType<typeof multipartUpload>, withCookie = cookie) =>
    app.inject({
      method: 'POST',
      url: '/api/content/upload',
      cookies: withCookie ? { access_token: withCookie } : undefined,
      headers: body.headers,
      payload: body.payload,
    });

  it('uploads a valid JPEG → 201 with contentId (unpublished)', async () => {
    const res = await upload(
      multipartUpload({
        fields: { title: 'Sunset', type: 'IMAGE', tier: 'STANDARD' },
        file: { content: JPEG, contentType: 'image/jpeg' },
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: 'Sunset', tier: 'STANDARD', type: 'IMAGE', isPublished: false });
    expect(res.json().contentId).toBeTruthy();
    expect(prisma.__content).toHaveLength(1);
    expect(prisma.__content[0].isPublished).toBe(false);
    expect(prisma.__content[0].width).toBe(800);
    expect(storageBundle.storage.uploadFile).toHaveBeenCalledOnce();
    // storageKey must never surface in the response.
    expect(JSON.stringify(res.json())).not.toContain('storageKey');
  });

  it('rejects a mismatched Content-Type (PNG bytes as image/jpeg) → 400', async () => {
    const res = await upload(
      multipartUpload({
        fields: { title: 'Fake', type: 'IMAGE' },
        file: { content: PNG, contentType: 'image/jpeg' },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(prisma.__content).toHaveLength(0);
  });

  it('rejects a subscriber → 403', async () => {
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    const res = await upload(
      multipartUpload({
        fields: { title: 'Nope', type: 'IMAGE' },
        file: { content: JPEG, contentType: 'image/jpeg' },
      }),
      subCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated upload → 401', async () => {
    const body = multipartUpload({
      fields: { title: 'Nope', type: 'IMAGE' },
      file: { content: JPEG, contentType: 'image/jpeg' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/content/upload',
      headers: body.headers,
      payload: body.payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an image over the 50 MB limit → 413', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(50 * 1024 * 1024, 0x00)]);
    const res = await upload(
      multipartUpload({
        fields: { title: 'Huge', type: 'IMAGE' },
        file: { content: big, contentType: 'image/jpeg' },
      }),
    );
    expect(res.statusCode).toBe(413);
    expect(prisma.__content).toHaveLength(0);
  });
});

// ── Publish ──────────────────────────────────────────────────────────────────
describe('PATCH /api/content/:contentId/publish', () => {
  let prisma: FakePrisma;
  let app: App;
  let cookie: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma, createFakeStorage().storage, createFakeImages());
    cookie = await loginAs(app, prisma, 'model', 'model@example.com');
  });

  it('publishes own content → 200 isPublished:true', async () => {
    const modelId = userIdFor(prisma, 'model@example.com');
    const c = seedContent(prisma, { modelId, isPublished: false });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/content/${c.id}/publish`,
      cookies: { access_token: cookie },
      payload: { publish: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ contentId: c.id, isPublished: true });
    expect(prisma.__content[0].isPublished).toBe(true);
  });

  it("forbids publishing another model's content → 403", async () => {
    const otherCookie = await loginAs(app, prisma, 'model', 'other@example.com');
    const ownerId = userIdFor(prisma, 'model@example.com');
    const c = seedContent(prisma, { modelId: ownerId, isPublished: false });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/content/${c.id}/publish`,
      cookies: { access_token: otherCookie },
      payload: { publish: true },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.__content[0].isPublished).toBe(false);
  });
});

// ── List ─────────────────────────────────────────────────────────────────────
describe('GET /api/content/model/:modelId', () => {
  let prisma: FakePrisma;
  let app: App;
  let modelId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma, createFakeStorage().storage, createFakeImages());
    await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
    seedContent(prisma, { modelId, tier: 'FREE', title: 'Teaser', isPublished: true });
    seedContent(prisma, { modelId, tier: 'STANDARD', title: 'Members only', isPublished: true });
  });

  it('returns only FREE published content to an anonymous requester', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/content/model/${modelId}` });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe('FREE');
    expect(items[0].thumbnailUrl).toBeTruthy();
    expect(JSON.stringify(res.json())).not.toContain('storageKey');
  });

  it('includes STANDARD content for a subscriber with access', async () => {
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    const subId = userIdFor(prisma, 'sub@example.com');
    const standard = prisma.__content.find((c) => c.tier === 'STANDARD')!;
    grantAccess(prisma, standard.id, subId, 'subscription_standard');

    const res = await app.inject({
      method: 'GET',
      url: `/api/content/model/${modelId}`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    const std = items.find((i) => i.tier === 'STANDARD')!;
    expect(std.hasAccess).toBe(true);
    expect(std.thumbnailUrl).toBeTruthy();
  });

  it('excludes STANDARD content from a subscriber without access', async () => {
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub2@example.com');
    const res = await app.inject({
      method: 'GET',
      url: `/api/content/model/${modelId}`,
      cookies: { access_token: subCookie },
    });
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe('FREE');
  });
});

// ── Serve ────────────────────────────────────────────────────────────────────
describe('GET /api/content/:contentId/serve', () => {
  let prisma: FakePrisma;
  let images: ImageProcessor;
  let app: App;
  let modelId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    images = createFakeImages();
    app = await makeApp(prisma, createFakeStorage().storage, images);
    await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
  });

  it('serves watermarked bytes (no-store) to a subscriber with access', async () => {
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    const subId = userIdFor(prisma, 'sub@example.com');
    const c = seedContent(prisma, { modelId, tier: 'STANDARD' });
    grantAccess(prisma, c.id, subId, 'subscription_standard');

    const res = await app.inject({
      method: 'GET',
      url: `/api/content/${c.id}/serve`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.rawPayload.toString()).toContain(WATERMARK_MARKER);
    // Watermark label carries the platform brand + the requester's email.
    expect(res.rawPayload.toString()).toContain('sub@example.com');
    expect(images.watermark).toHaveBeenCalledOnce();
    expect(prisma.__content.find((x) => x.id === c.id)!.viewCount).toBe(1);
  });

  it('forbids a subscriber without access → 403', async () => {
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    const c = seedContent(prisma, { modelId, tier: 'STANDARD' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/content/${c.id}/serve`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(images.watermark).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated serve request → 401', async () => {
    const c = seedContent(prisma, { modelId, tier: 'STANDARD' });
    const res = await app.inject({ method: 'GET', url: `/api/content/${c.id}/serve` });
    expect(res.statusCode).toBe(401);
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────
describe('DELETE /api/content/:contentId', () => {
  let prisma: FakePrisma;
  let app: App;
  let cookie: string;
  let modelId: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    app = await makeApp(prisma, createFakeStorage().storage, createFakeImages());
    cookie = await loginAs(app, prisma, 'model', 'model@example.com');
    modelId = userIdFor(prisma, 'model@example.com');
  });

  it('soft-deletes own content → 204 and sets deletedAt', async () => {
    const c = seedContent(prisma, { modelId, isPublished: true });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/content/${c.id}`,
      cookies: { access_token: cookie },
    });
    expect(res.statusCode).toBe(204);
    const row = prisma.__content.find((x) => x.id === c.id)!;
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.isPublished).toBe(false);
  });

  it("forbids deleting another model's content → 403", async () => {
    const otherCookie = await loginAs(app, prisma, 'model', 'other@example.com');
    const c = seedContent(prisma, { modelId, isPublished: true });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/content/${c.id}`,
      cookies: { access_token: otherCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.__content.find((x) => x.id === c.id)!.deletedAt).toBeNull();
  });
});
