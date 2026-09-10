// =============================================================================
// Private messaging integration tests (Session 07).
//
// Same posture as every suite before it: no real database, no real bucket, no
// network. The shared in-memory Prisma fake, a fake StorageClient, and Fastify's
// `inject` for HTTP; auth cookies come from the real register→verify→login flow
// against the same fake DB, so RBAC is exercised end to end rather than stubbed.
//
// The WebSocket suite is the one exception: a socket cannot be `inject`ed, so it
// boots the same `buildServer()` app on an ephemeral port and dials it with a
// real `ws` client. That is the only way to prove the property that matters —
// that authentication happens during the upgrade, from the httpOnly cookie.
//
// The properties under test:
//   * conversation creation needs an ACTIVE subscription; a lapsed one is 403
//   * sending re-checks that subscription LIVE, and never gates the model
//   * a non-participant gets 404, never 403 — ids stay non-enumerable
//   * `attachmentStorageKey` appears in no response, on any route, ever
//   * the conversation list is O(1) in queries, not O(conversations)
//   * a socket receives `message.new` for a message posted over REST
// =============================================================================
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../index.js';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import {
  createFakeEmailer,
  createFakePrisma,
  seedConversation,
  seedMessage,
  seedProfile,
  seedSubscription,
  type FakePrisma,
} from '../../test/fake-prisma.js';
import { MAX_MESSAGE_IMAGE_BYTES } from './messaging.routes.js';
import { MAX_CONNECTIONS_PER_USER } from './connections.js';

// ── Fakes ────────────────────────────────────────────────────────────────────
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
    getObject: vi.fn(async () => Buffer.from('RAW')),
    deleteFile: vi.fn(async () => {}),
  };
  return { storage, uploaded };
}

function createFakeImages(): ImageProcessor {
  return {
    getDimensions: vi.fn(async () => ({ width: 800, height: 600 })),
    watermark: vi.fn(async (buffer: Buffer) => buffer),
  };
}

async function makeApp(prisma: FakePrisma, storage: StorageClient) {
  return buildServer({
    prisma: prisma as unknown as PrismaClient,
    emailer: createFakeEmailer(),
    storage,
    images: createFakeImages(),
  });
}

type App = Awaited<ReturnType<typeof makeApp>>;

/** register → verify → login, returning the access_token cookie value. */
async function loginAs(
  app: App,
  prisma: FakePrisma,
  role: 'model' | 'subscriber',
  email: string,
): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'supersecret', displayName: `Test ${role}`, role },
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

// Minimal but valid magic-byte signatures for file-type sniffing.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom', 'ascii'),
]);

/** Build a multipart/form-data body: optional text field + optional file part. */
function multipartMessage(opts: {
  fields?: Record<string, string>;
  file?: { content: Buffer; contentType: string; field?: string; filename?: string };
}) {
  const boundary = `----cpb${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(opts.fields ?? {})) {
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

/**
 * A world with one model, one subscriber, an ACTIVE subscription between them,
 * and both parties logged in — the starting point for nearly every test here.
 */
async function setupPair(status = 'ACTIVE') {
  const prisma = createFakePrisma();
  const { storage, uploaded } = createFakeStorage();
  const app = await makeApp(prisma, storage);

  const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
  const modelCookie = await loginAs(app, prisma, 'model', 'model@example.com');
  const subscriberId = userIdFor(prisma, 'sub@example.com');
  const modelId = userIdFor(prisma, 'model@example.com');
  seedProfile(prisma, modelId);
  seedSubscription(prisma, { subscriberId, modelId, status });

  return { prisma, app, storage, uploaded, subCookie, modelCookie, subscriberId, modelId };
}

// ── POST /api/messages/conversations/:modelId ────────────────────────────────
describe('POST /api/messages/conversations/:modelId', () => {
  it('creates the conversation for an ACTIVE subscriber (201), then returns it (200)', async () => {
    const { app, subCookie, modelId, subscriberId } = await setupPair();

    const first = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${modelId}`,
      cookies: { access_token: subCookie },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ subscriberId, modelId, lastMessageAt: null });

    // Idempotent: the pair is UNIQUE, so a second call is a read, not a race.
    const second = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${modelId}`,
      cookies: { access_token: subCookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().conversationId).toBe(first.json().conversationId);
  });

  it('rejects a PAST_DUE subscriber with 403 subscription_required', async () => {
    const { app, subCookie, modelId } = await setupPair('PAST_DUE');
    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${modelId}`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'subscription_required' });
  });

  it('rejects a subscriber with no subscription at all with 403', async () => {
    const prisma = createFakePrisma();
    const { storage } = createFakeStorage();
    const app = await makeApp(prisma, storage);
    const subCookie = await loginAs(app, prisma, 'subscriber', 'sub@example.com');
    await loginAs(app, prisma, 'model', 'model@example.com');
    const modelId = userIdFor(prisma, 'model@example.com');
    seedProfile(prisma, modelId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${modelId}`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'subscription_required' });
  });

  it('404s an unknown model id', async () => {
    const { app, subCookie } = await setupPair();
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/conversations/u_does_not_exist',
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'model_not_found' });
  });

  it('403s a model trying to open a conversation (subscriber-only route)', async () => {
    const { app, modelCookie, modelId } = await setupPair();
    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${modelId}`,
      cookies: { access_token: modelCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('401s an anonymous caller', async () => {
    const { app, modelId } = await setupPair();
    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${modelId}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /api/messages/conversations ──────────────────────────────────────────
describe('GET /api/messages/conversations', () => {
  it('returns the other participant, a last-message preview and an unread count', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    seedMessage(prisma, { conversationId: conversation.id, senderId: subscriberId, body: 'hi' });
    seedMessage(prisma, {
      conversationId: conversation.id,
      senderId: modelId,
      body: 'hey there',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages/conversations',
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversations).toHaveLength(1);
    expect(res.json().conversations[0]).toMatchObject({
      conversationId: conversation.id,
      otherParticipantId: modelId,
      otherParticipantDisplayName: 'Test model',
      lastMessagePreview: 'hey there',
      // Only the *other* party's unread messages count.
      unreadCount: 1,
    });
  });

  it('labels an attachment-only last message by kind', async () => {
    const { prisma, app, modelCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    seedMessage(prisma, {
      conversationId: conversation.id,
      senderId: subscriberId,
      body: null,
      attachmentType: 'IMAGE',
      attachmentStorageKey: `messages/${conversation.id}/x.jpg`,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages/conversations',
      cookies: { access_token: modelCookie },
    });
    expect(res.json().conversations[0]).toMatchObject({
      lastMessagePreview: '[image]',
      otherParticipantId: subscriberId,
      unreadCount: 1,
    });
  });

  it('orders by lastMessageAt DESC with empty conversations last', async () => {
    const { prisma, app, modelCookie, modelId } = await setupPair();
    // Three more subscribers, so the model's inbox has something to order.
    const older = seedConversation(prisma, { subscriberId: 'u_a', modelId });
    const newer = seedConversation(prisma, { subscriberId: 'u_b', modelId });
    const empty = seedConversation(prisma, { subscriberId: 'u_c', modelId });
    prisma.__users.push(
      ...['u_a', 'u_b', 'u_c'].map((id) => ({
        id,
        email: `${id}@example.com`,
        passwordHash: 'seeded',
        role: 'SUBSCRIBER' as const,
        displayName: id,
        isVerified: true,
        verifyToken: null,
        verifyTokenExpiresAt: null,
        refreshTokenHash: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    older.lastMessageAt = new Date(Date.now() - 60_000);
    newer.lastMessageAt = new Date();

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages/conversations',
      cookies: { access_token: modelCookie },
    });
    const ids = res.json().conversations.map((c: { conversationId: string }) => c.conversationId);
    expect(ids.slice(0, 3)).toEqual([newer.id, older.id, empty.id]);
  });

  it('costs a constant number of queries regardless of conversation count (no N+1)', async () => {
    const { prisma, app, modelCookie, modelId } = await setupPair();
    for (let i = 0; i < 12; i++) {
      const subscriberId = `u_bulk_${i}`;
      prisma.__users.push({
        id: subscriberId,
        email: `bulk${i}@example.com`,
        passwordHash: 'seeded',
        role: 'SUBSCRIBER',
        displayName: `Bulk ${i}`,
        isVerified: true,
        verifyToken: null,
        verifyTokenExpiresAt: null,
        refreshTokenHash: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const conversation = seedConversation(prisma, { subscriberId, modelId });
      seedMessage(prisma, { conversationId: conversation.id, senderId: subscriberId });
      seedMessage(prisma, { conversationId: conversation.id, senderId: modelId });
    }

    prisma.__resetCalls();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages/conversations',
      cookies: { access_token: modelCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversations).toHaveLength(12);

    // One conversation read, one aggregated unread groupBy, one DISTINCT ON
    // read for every last message — and nothing per conversation.
    expect(prisma.__calls['conversation.findMany']).toBe(1);
    expect(prisma.__calls['message.groupBy']).toBe(1);
    expect(prisma.__calls['message.findMany']).toBe(1);
    expect(prisma.__calls['message.findUnique']).toBeUndefined();
    expect(prisma.__calls['conversation.findUnique']).toBeUndefined();
  });

  it('401s an anonymous caller', async () => {
    const { app } = await setupPair();
    const res = await app.inject({ method: 'GET', url: '/api/messages/conversations' });
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /api/messages/conversations/:conversationId/messages ─────────────────
describe('GET /api/messages/conversations/:conversationId/messages', () => {
  it('returns history newest-first and pages with an opaque cursor', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    for (let i = 1; i <= 5; i++) {
      seedMessage(prisma, {
        conversationId: conversation.id,
        senderId: subscriberId,
        body: `m${i}`,
      });
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${conversation.id}/messages?limit=2`,
      cookies: { access_token: subCookie },
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().messages.map((m: { body: string }) => m.body)).toEqual(['m5', 'm4']);
    expect(page1.json().nextCursor).toBeTruthy();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${conversation.id}/messages?limit=2&before=${page1.json().nextCursor}`,
      cookies: { access_token: subCookie },
    });
    expect(page2.json().messages.map((m: { body: string }) => m.body)).toEqual(['m3', 'm2']);

    const page3 = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${conversation.id}/messages?limit=2&before=${page2.json().nextCursor}`,
      cookies: { access_token: subCookie },
    });
    expect(page3.json().messages.map((m: { body: string }) => m.body)).toEqual(['m1']);
    // A short page is the end of the history, so there is nothing to page to.
    expect(page3.json().nextCursor).toBeNull();
  });

  it('never serializes attachmentStorageKey', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    seedMessage(prisma, {
      conversationId: conversation.id,
      senderId: modelId,
      body: null,
      attachmentType: 'VIDEO',
      attachmentStorageKey: `messages/${conversation.id}/secret-key.mp4`,
      attachmentMimeType: 'video/mp4',
      attachmentSizeBytes: 4242,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
    });
    expect(res.payload).not.toContain('secret-key.mp4');
    expect(res.payload).not.toContain('attachmentStorageKey');
    expect(res.json().messages[0]).toMatchObject({
      attachmentType: 'VIDEO',
      attachmentMimeType: 'video/mp4',
      attachmentSizeBytes: 4242,
    });
  });

  it('404s (not 403s) a non-participant, so conversation ids are not enumerable', async () => {
    const { prisma, app, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    const outsiderCookie = await loginAs(app, prisma, 'subscriber', 'outsider@example.com');

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'conversation_not_found' });

    // Indistinguishable from a conversation that simply does not exist.
    const missing = await app.inject({
      method: 'GET',
      url: '/api/messages/conversations/conv_nope/messages',
      cookies: { access_token: outsiderCookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(res.json());
  });

  it('rejects a limit above the 100 ceiling', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${conversation.id}/messages?limit=500`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /api/messages/conversations/:conversationId/messages ────────────────
describe('POST /api/messages/conversations/:conversationId/messages', () => {
  it('persists a text message from an ACTIVE subscriber and bumps lastMessageAt', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      payload: { text: '  hello there  ' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      conversationId: conversation.id,
      senderId: subscriberId,
      body: 'hello there',
      attachmentType: null,
      readAt: null,
    });
    expect(prisma.__conversations[0].lastMessageAt).not.toBeNull();
  });

  it('403s subscription_inactive when the subscription lapsed after the conversation existed', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    // The gate is live, not cached from creation time.
    prisma.__subscriptions[0].status = 'EXPIRED';

    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      payload: { text: 'still there?' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'subscription_inactive' });
    expect(prisma.__messages).toHaveLength(0);
  });

  it('lets the model reply even when the subscriber lapsed', async () => {
    const { prisma, app, modelCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    prisma.__subscriptions[0].status = 'CANCELED';

    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: modelCookie },
      payload: { text: 'always here for you' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().senderId).toBe(modelId);
  });

  it('leaves history readable to a lapsed subscriber (nothing is retroactively hidden)', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    seedMessage(prisma, { conversationId: conversation.id, senderId: modelId, body: 'paid for' });
    prisma.__subscriptions[0].status = 'EXPIRED';

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages[0].body).toBe('paid for');
  });

  it('400s empty_message when there is neither text nor attachment', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      payload: { text: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'empty_message' });
  });

  it('400s a body over the 4000-character ceiling', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      payload: { text: 'x'.repeat(4001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_input');
    // The rejected body must not travel back out in the error payload.
    expect(res.payload).not.toContain('xxxxxxxxxx');
  });

  it('404s a non-participant trying to send', async () => {
    const { prisma, app, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    const outsiderCookie = await loginAs(app, prisma, 'subscriber', 'outsider@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: outsiderCookie },
      payload: { text: 'let me in' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'conversation_not_found' });
  });

  it('stores a validated image attachment under messages/{conversationId}/ and returns no key', async () => {
    const { prisma, app, uploaded, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const body = multipartMessage({
      fields: { text: 'look at this' },
      file: { content: JPEG, contentType: 'image/jpeg', filename: 'pic.jpg' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      headers: body.headers,
      payload: body.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      body: 'look at this',
      attachmentType: 'IMAGE',
      attachmentMimeType: 'image/jpeg',
      attachmentSizeBytes: JPEG.length,
    });
    expect(res.payload).not.toContain('attachmentStorageKey');

    const [key] = [...uploaded.keys()];
    expect(key).toMatch(new RegExp(`^messages/${conversation.id}/[a-z0-9]+\\.jpg$`));
    expect(res.payload).not.toContain(key);
  });

  it('accepts an attachment-only message (no text)', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const body = multipartMessage({
      file: { content: MP4, contentType: 'video/mp4', filename: 'clip.mp4' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      headers: body.headers,
      payload: body.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ body: null, attachmentType: 'VIDEO' });
  });

  it('415s when the declared Content-Type contradicts the bytes', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const body = multipartMessage({
      // PNG bytes announced as a JPEG — the sniffed type wins and the send fails.
      file: { content: PNG, contentType: 'image/jpeg', filename: 'lie.jpg' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      headers: body.headers,
      payload: body.payload,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'attachment_content_type_mismatch' });
  });

  it('415s a file that is not an allowed image/video type', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const body = multipartMessage({
      file: {
        content: Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8'),
        contentType: 'image/png',
        filename: 'payload.png',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      headers: body.headers,
      payload: body.payload,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'unsupported_attachment_type' });
  });

  it('413s an image past the 15 MB chat cap', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const oversized = Buffer.concat([JPEG, Buffer.alloc(MAX_MESSAGE_IMAGE_BYTES)]);
    const body = multipartMessage({
      file: { content: oversized, contentType: 'image/jpeg', filename: 'huge.jpg' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      headers: body.headers,
      payload: body.payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'attachment_too_large' });
  });
});

// ── GET /api/messages/attachments/:messageId ─────────────────────────────────
describe('GET /api/messages/attachments/:messageId', () => {
  it('mints a 60-second signed URL for a participant, never the key', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    const message = seedMessage(prisma, {
      conversationId: conversation.id,
      senderId: modelId,
      body: null,
      attachmentType: 'IMAGE',
      attachmentStorageKey: `messages/${conversation.id}/private.jpg`,
      attachmentMimeType: 'image/jpeg',
      attachmentSizeBytes: 100,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/attachments/${message.id}`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expiresIn).toBe(60);
    expect(res.json().signedUrl).toContain('ttl=60');
  });

  it('404s a non-participant', async () => {
    const { prisma, app, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    const message = seedMessage(prisma, {
      conversationId: conversation.id,
      senderId: modelId,
      attachmentType: 'IMAGE',
      attachmentStorageKey: `messages/${conversation.id}/private.jpg`,
    });
    const outsiderCookie = await loginAs(app, prisma, 'subscriber', 'outsider@example.com');

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/attachments/${message.id}`,
      cookies: { access_token: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'attachment_not_found' });
  });

  it('404s a message that carries no attachment', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    const message = seedMessage(prisma, {
      conversationId: conversation.id,
      senderId: modelId,
      body: 'text only',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/attachments/${message.id}`,
      cookies: { access_token: subCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── PATCH /api/messages/conversations/:conversationId/read ───────────────────
describe('PATCH /api/messages/conversations/:conversationId/read', () => {
  it("marks the other participant's unread messages read, and is idempotent", async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    seedMessage(prisma, { conversationId: conversation.id, senderId: modelId, body: 'a' });
    seedMessage(prisma, { conversationId: conversation.id, senderId: modelId, body: 'b' });
    // The caller's own message is read by definition and must not be touched.
    seedMessage(prisma, { conversationId: conversation.id, senderId: subscriberId, body: 'c' });

    const first = await app.inject({
      method: 'PATCH',
      url: `/api/messages/conversations/${conversation.id}/read`,
      cookies: { access_token: subCookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ conversationId: conversation.id, markedRead: 2 });
    expect(prisma.__messages.find((m) => m.body === 'c')!.readAt).toBeNull();

    const second = await app.inject({
      method: 'PATCH',
      url: `/api/messages/conversations/${conversation.id}/read`,
      cookies: { access_token: subCookie },
    });
    expect(second.json()).toEqual({ conversationId: conversation.id, markedRead: 0 });
  });

  it('404s a non-participant', async () => {
    const { prisma, app, subscriberId, modelId } = await setupPair();
    const conversation = seedConversation(prisma, { subscriberId, modelId });
    const outsiderCookie = await loginAs(app, prisma, 'subscriber', 'outsider@example.com');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/conversations/${conversation.id}/read`,
      cookies: { access_token: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── WebSocket: GET /ws/messages ──────────────────────────────────────────────
//
// The only suite that needs a real listening server: an upgrade cannot be
// `inject`ed, and "authentication happens during the handshake" is precisely
// the property worth proving against a real socket.
describe('GET /ws/messages', () => {
  let ctx: Awaited<ReturnType<typeof setupPair>>;
  let url: string;
  const open: WebSocket[] = [];

  const connect = (cookie?: string) => {
    const socket = new WebSocket(url, {
      headers: cookie ? { cookie: `access_token=${cookie}` } : {},
    });
    open.push(socket);
    return socket;
  };

  /** Resolve on the socket's first message, reject if it closes first. */
  const nextMessage = (socket: WebSocket) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(String(data))));
      socket.once('close', () => reject(new Error('socket closed before a message arrived')));
      socket.once('error', reject);
    });

  const opened = (socket: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

  beforeEach(async () => {
    ctx = await setupPair();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/ws/messages`;
  });

  afterEach(async () => {
    for (const socket of open.splice(0)) socket.terminate();
    await ctx.app.close();
  });

  it('rejects an upgrade with no access-token cookie (401, no socket)', async () => {
    const socket = connect();
    await expect(opened(socket)).rejects.toThrow(/401/);
  });

  it('rejects an upgrade carrying a bogus token', async () => {
    const socket = connect('not-a-jwt');
    await expect(opened(socket)).rejects.toThrow(/401/);
  });

  it('pushes message.new to the recipient when the other party posts over REST', async () => {
    const { prisma, app, subCookie, modelCookie, subscriberId, modelId } = ctx;
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const modelSocket = connect(modelCookie);
    await opened(modelSocket);
    const delivered = nextMessage(modelSocket);

    const posted = await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      payload: { text: 'are you there?' },
    });
    expect(posted.statusCode).toBe(201);

    const event = await delivered;
    expect(event.type).toBe('message.new');
    expect(event.message).toMatchObject({
      messageId: posted.json().messageId,
      conversationId: conversation.id,
      senderId: subscriberId,
      body: 'are you there?',
    });
    expect(JSON.stringify(event)).not.toContain('attachmentStorageKey');
  });

  it('does not echo a message back to its own sender', async () => {
    const { prisma, app, subCookie, subscriberId, modelId } = ctx;
    const conversation = seedConversation(prisma, { subscriberId, modelId });

    const senderSocket = connect(subCookie);
    await opened(senderSocket);
    const frames: unknown[] = [];
    senderSocket.on('message', (data) => frames.push(JSON.parse(String(data))));

    await app.inject({
      method: 'POST',
      url: `/api/messages/conversations/${conversation.id}/messages`,
      cookies: { access_token: subCookie },
      payload: { text: 'my own words' },
    });
    // Give the (synchronous) fan-out a turn of the event loop to be wrong in.
    await new Promise((resolve) => setImmediate(resolve));
    expect(frames).toHaveLength(0);
  });

  it(`closes the connection past ${MAX_CONNECTIONS_PER_USER} concurrent sockets`, async () => {
    const { subCookie } = ctx;
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      await opened(connect(subCookie));
    }

    const extra = connect(subCookie);
    await opened(extra);
    const code = await new Promise<number>((resolve) => extra.once('close', resolve));
    expect(code).toBe(4029);
  });
});
