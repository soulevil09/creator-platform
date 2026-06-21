// Model onboarding integration tests.
//
// Like the auth suite, these run with NO real database, email, or object
// storage: we inject an in-memory Prisma fake, a fake emailer, and a fake
// StorageClient into buildServer() and drive the HTTP layer with Fastify's
// `inject`. Auth cookies are obtained by running the real register→verify→login
// flow against the same fake DB, so RBAC is exercised end-to-end.
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { Emailer } from '../../lib/email.js';
import type { StorageClient } from '../../lib/storage.js';

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
  displayName: string;
  bio: string | null;
  country: string;
  currency: string;
  aiConsent: boolean;
  aiConsentAt: Date | null;
  tosAcceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeImage {
  id: string;
  modelProfileId: string;
  storageKey: string;
  signedUrl: string | null;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

type Where = Record<string, unknown>;

function createFakePrisma() {
  const users: FakeUser[] = [];
  const profiles: FakeProfile[] = [];
  const images: FakeImage[] = [];
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
      findUnique: async ({ where, include }: { where: Where; include?: Where }) => {
        const profile = profiles.find(
          (p) =>
            (where.userId !== undefined && p.userId === where.userId) ||
            (where.id !== undefined && p.id === where.id),
        );
        if (!profile) return null;
        if (include?.referenceImages) {
          const refs = images
            .filter((i) => i.modelProfileId === profile.id)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return { ...profile, referenceImages: refs };
        }
        return profile;
      },
      create: async ({ data }: { data: Partial<FakeProfile> & { userId: string } }) => {
        const now = new Date();
        const profile = {
          bio: null,
          currency: 'USD',
          aiConsent: false,
          aiConsentAt: null,
          tosAcceptedAt: null,
          ...data,
          id: `mp_${++seq}`,
          createdAt: now,
          updatedAt: now,
        } as FakeProfile;
        profiles.push(profile);
        return profile;
      },
      update: async ({ where, data }: { where: Where; data: Partial<FakeProfile> }) => {
        const profile = profiles.find((p) => p.userId === where.userId);
        if (!profile) throw new Error('record not found');
        Object.assign(profile, data, { updatedAt: new Date() });
        return profile;
      },
    },

    referenceImage: {
      count: async ({ where }: { where: Where }) =>
        images.filter((i) => i.modelProfileId === where.modelProfileId).length,
      create: async ({ data }: { data: Partial<FakeImage> & { modelProfileId: string } }) => {
        const image = {
          signedUrl: null,
          ...data,
          id: `ri_${++seq}`,
          createdAt: new Date(Date.now() + seq),
        } as FakeImage;
        images.push(image);
        return image;
      },
      findUnique: async ({ where, include }: { where: Where; include?: Where }) => {
        const image = images.find((i) => i.id === where.id);
        if (!image) return null;
        if (include?.modelProfile) {
          const profile = profiles.find((p) => p.id === image.modelProfileId) ?? null;
          return { ...image, modelProfile: profile };
        }
        return image;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const idx = images.findIndex((i) => i.id === where.id);
        if (idx === -1) throw new Error('record not found');
        const [removed] = images.splice(idx, 1);
        return removed;
      },
    },

    __users: users,
    __profiles: profiles,
    __images: images,
  };
  return client;
}

type FakePrisma = ReturnType<typeof createFakePrisma>;

function createFakeEmailer(): Emailer {
  return { sendVerificationEmail: vi.fn(async () => {}) };
}

function createFakeStorage() {
  const uploaded = new Map<string, { bucket: string; mimeType: string; size: number }>();
  const deleted: string[] = [];
  const storage: StorageClient = {
    uploadFile: vi.fn(async (bucket: string, key: string, buffer: Buffer, mimeType: string) => {
      uploaded.set(key, { bucket, mimeType, size: buffer.length });
      return key;
    }),
    getSignedUrl: vi.fn(
      async (_bucket: string, key: string, ttl: number) =>
        `https://signed.example/${key}?ttl=${ttl}`,
    ),
    deleteFile: vi.fn(async (_bucket: string, key: string) => {
      deleted.push(key);
      uploaded.delete(key);
    }),
  };
  return { storage, uploaded, deleted };
}

async function makeApp(prisma: FakePrisma, storage: StorageClient) {
  return buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
type App = Awaited<ReturnType<typeof makeApp>>;

/** Run register→verify→login for a role; return the access_token cookie value. */
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

/** Build a single-file multipart/form-data body for `inject`. */
function multipartImage(content: Buffer, contentType: string, field = 'image') {
  const boundary = `----cpb${randomBytes(8).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="ref"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// Minimal but valid magic-byte signatures for file-type sniffing.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1');

const validProfile = {
  displayName: 'Jane Doe',
  bio: '  Brazilian model  ',
  country: 'br',
  currency: 'BRL' as const,
};

async function createProfile(app: App, cookie: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'PUT',
    url: '/api/onboarding/profile',
    cookies: { access_token: cookie },
    payload: { ...validProfile, ...overrides },
  });
}

// ── Profile upsert ───────────────────────────────────────────────────────────
describe('PUT /api/onboarding/profile', () => {
  let prisma: FakePrisma;
  let storage: StorageClient;
  let app: App;
  let cookie: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    ({ storage } = createFakeStorage());
    app = await makeApp(prisma, storage);
    cookie = await loginAs(app, prisma, 'model', 'model@example.com');
  });

  it('creates a profile (201), trimming and normalising inputs', async () => {
    const res = await createProfile(app, cookie);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      displayName: 'Jane Doe',
      country: 'BR', // upper-cased
      currency: 'BRL',
      aiConsent: false,
      tosAcceptedAt: null,
    });
    expect(res.json().profileId).toBeTruthy();
    // bio was trimmed on the way in.
    expect(prisma.__profiles[0].bio).toBe('Brazilian model');
  });

  it('updates the profile idempotently (200 on second call)', async () => {
    await createProfile(app, cookie);
    const res = await createProfile(app, cookie, { displayName: 'Jane R.' });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe('Jane R.');
    expect(prisma.__profiles).toHaveLength(1);
  });

  it('stamps tosAcceptedAt when tosAccepted:true', async () => {
    const res = await createProfile(app, cookie, { tosAccepted: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().tosAcceptedAt).toBeTruthy();
    expect(prisma.__profiles[0].tosAcceptedAt).toBeInstanceOf(Date);
  });

  it('rejects a displayName shorter than 2 chars (400)', async () => {
    const res = await createProfile(app, cookie, { displayName: 'A' });
    expect(res.statusCode).toBe(400);
    expect(prisma.__profiles).toHaveLength(0);
  });

  it('rejects a non 2-letter country code (400)', async () => {
    const res = await createProfile(app, cookie, { country: 'BRA' });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication (401) and the MODEL role (403)', async () => {
    const noauth = await app.inject({ method: 'PUT', url: '/api/onboarding/profile', payload: validProfile });
    expect(noauth.statusCode).toBe(401);

    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    const forbidden = await createProfile(app, subCookie);
    expect(forbidden.statusCode).toBe(403);
  });
});

// ── Consent ──────────────────────────────────────────────────────────────────
describe('POST /api/onboarding/consent', () => {
  let prisma: FakePrisma;
  let storage: StorageClient;
  let app: App;
  let cookie: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    ({ storage } = createFakeStorage());
    app = await makeApp(prisma, storage);
    cookie = await loginAs(app, prisma, 'model', 'model@example.com');
  });

  const postConsent = (aiConsent: boolean) =>
    app.inject({
      method: 'POST',
      url: '/api/onboarding/consent',
      cookies: { access_token: cookie },
      payload: { aiConsent },
    });

  it('returns 404 when no profile exists yet', async () => {
    const res = await postConsent(true);
    expect(res.statusCode).toBe(404);
  });

  it('blocks consent until the ToS is accepted (400)', async () => {
    await createProfile(app, cookie); // no tosAccepted
    const res = await postConsent(true);
    expect(res.statusCode).toBe(400);
    expect(prisma.__profiles[0].aiConsent).toBe(false);
  });

  it('grants then revokes consent once the ToS is accepted', async () => {
    await createProfile(app, cookie, { tosAccepted: true });

    const granted = await postConsent(true);
    expect(granted.statusCode).toBe(200);
    expect(granted.json().aiConsent).toBe(true);
    expect(granted.json().aiConsentAt).toBeTruthy();

    const revoked = await postConsent(false);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ aiConsent: false, aiConsentAt: null });
  });
});

// ── Reference images ─────────────────────────────────────────────────────────
describe('reference images', () => {
  let prisma: FakePrisma;
  let storageBundle: ReturnType<typeof createFakeStorage>;
  let app: App;
  let cookie: string;

  const upload = (body: ReturnType<typeof multipartImage>) =>
    app.inject({
      method: 'POST',
      url: '/api/onboarding/reference-images',
      cookies: { access_token: cookie },
      headers: body.headers,
      payload: body.payload,
    });

  beforeEach(async () => {
    prisma = createFakePrisma();
    storageBundle = createFakeStorage();
    app = await makeApp(prisma, storageBundle.storage);
    cookie = await loginAs(app, prisma, 'model', 'model@example.com');
    await createProfile(app, cookie, { tosAccepted: true });
  });

  it('accepts a valid PNG (201) and returns a signed URL, never the storage key', async () => {
    const res = await upload(multipartImage(PNG, 'image/png'));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ mimeType: 'image/png', sizeBytes: PNG.length });
    expect(res.json().signedUrl).toContain('https://signed.example/');
    expect(res.json().imageId).toBeTruthy();
    // Storage key must not be exposed as a field.
    expect(JSON.stringify(res.json())).not.toContain('storageKey');
    expect(storageBundle.storage.uploadFile).toHaveBeenCalledOnce();
  });

  it('accepts a valid JPEG (201)', async () => {
    const res = await upload(multipartImage(JPEG, 'image/jpeg'));
    expect(res.statusCode).toBe(201);
    expect(res.json().mimeType).toBe('image/jpeg');
  });

  it('rejects an unsupported type (GIF) with 400', async () => {
    const res = await upload(multipartImage(GIF, 'image/gif'));
    expect(res.statusCode).toBe(400);
    expect(prisma.__images).toHaveLength(0);
  });

  it('rejects a Content-Type that mismatches the file contents (400)', async () => {
    // PNG bytes declared as JPEG → magic-byte sniff disagrees with the header.
    const res = await upload(multipartImage(PNG, 'image/jpeg'));
    expect(res.statusCode).toBe(400);
    expect(prisma.__images).toHaveLength(0);
  });

  it('rejects a file larger than 10 MB with 400', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x01);
    const res = await upload(multipartImage(big, 'image/png'));
    expect(res.statusCode).toBe(400);
    expect(storageBundle.storage.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects an upload once the 10-image limit is reached (400)', async () => {
    const profileId = prisma.__profiles[0].id;
    for (let i = 0; i < 10; i++) {
      prisma.__images.push({
        id: `seed_${i}`,
        modelProfileId: profileId,
        storageKey: `reference-images/x/${i}.png`,
        signedUrl: null,
        mimeType: 'image/png',
        sizeBytes: 100,
        createdAt: new Date(),
      });
    }
    const res = await upload(multipartImage(PNG, 'image/png'));
    expect(res.statusCode).toBe(400);
    expect(prisma.__images).toHaveLength(10);
  });

  it('deletes an own image (204) and removes it from storage', async () => {
    const created = await upload(multipartImage(PNG, 'image/png'));
    const imageId = created.json().imageId as string;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/onboarding/reference-images/${imageId}`,
      cookies: { access_token: cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.__images).toHaveLength(0);
    expect(storageBundle.storage.deleteFile).toHaveBeenCalledOnce();
  });

  it("forbids deleting another model's image (403)", async () => {
    const created = await upload(multipartImage(PNG, 'image/png'));
    const imageId = created.json().imageId as string;

    // Second model, own profile, attempts to delete the first model's image.
    const otherCookie = await loginAs(app, prisma, 'model', 'other@example.com');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/onboarding/reference-images/${imageId}`,
      cookies: { access_token: otherCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.__images).toHaveLength(1); // not deleted
    expect(storageBundle.storage.deleteFile).not.toHaveBeenCalled();
  });

  it('requires authentication for uploads (401)', async () => {
    const body = multipartImage(PNG, 'image/png');
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/reference-images',
      headers: body.headers,
      payload: body.payload,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /profile ─────────────────────────────────────────────────────────────
describe('GET /api/onboarding/profile', () => {
  let prisma: FakePrisma;
  let storage: StorageClient;
  let app: App;
  let cookie: string;

  beforeEach(async () => {
    prisma = createFakePrisma();
    ({ storage } = createFakeStorage());
    app = await makeApp(prisma, storage);
    cookie = await loginAs(app, prisma, 'model', 'model@example.com');
  });

  it('returns 404 before the profile is created', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/profile',
      cookies: { access_token: cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the full profile with fresh signed URLs (200) and no storage keys', async () => {
    await createProfile(app, cookie, { tosAccepted: true });
    await app.inject({
      method: 'POST',
      url: '/api/onboarding/reference-images',
      cookies: { access_token: cookie },
      ...multipartImage(PNG, 'image/png'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/profile',
      cookies: { access_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ displayName: 'Jane Doe', country: 'BR', currency: 'BRL' });
    expect(body.referenceImages).toHaveLength(1);
    expect(body.referenceImages[0].signedUrl).toContain('https://signed.example/');
    expect(body.referenceImages[0].signedUrl).toContain('ttl=300');
    expect(JSON.stringify(body)).not.toContain('storageKey');
  });

  it('rejects a SUBSCRIBER with 403', async () => {
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/profile',
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
