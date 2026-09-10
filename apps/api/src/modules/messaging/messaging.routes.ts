// HTTP layer for private messaging. Owns multipart parsing, magic-byte file
// validation, per-type size caps, rate limits and response shaping; delegates
// every read and write to the messaging service.
//
// The send endpoint is the ONLY way a message is created — the WebSocket does
// not accept writes. That keeps validation, the live subscription gate, the
// attachment checks and the rate limit in one auditable place, and leaves
// fan-out a pure read-side concern (the same discipline as Session 06.5's
// single `issueSubscriptionCharge` call site).
//
// Error bodies carry a machine-readable code (`subscription_inactive`,
// `empty_message`, …) rather than prose: a client has to branch on these, and
// the two subscription failures mean different things to a UI (buy a
// subscription vs. renew a lapsed one).
import { fileTypeFromBuffer } from 'file-type';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import type { MessageAttachmentType } from '@creator-platform/shared';
import { authenticate, authorize } from '../../middleware/auth.js';
import { MessagingError, type MessagingService } from './messaging.service.js';
import {
  conversationIdParamsSchema,
  messageHistoryQuerySchema,
  messageIdParamsSchema,
  modelIdParamsSchema,
  sendMessageBodySchema,
} from './messaging.schema.js';

export interface MessagingRoutesOptions extends FastifyPluginOptions {
  service: MessagingService;
}

/**
 * Accepted attachment MIME types → { ext, type }. An explicit allow-list, not a
 * `startsWith('image/')` test: the set of things a browser will happily execute
 * when handed the wrong Content-Type is larger than the set we want to store.
 */
const ALLOWED_ATTACHMENT_TYPES = new Map<string, { ext: string; type: MessageAttachmentType }>([
  ['image/jpeg', { ext: 'jpg', type: 'IMAGE' }],
  ['image/png', { ext: 'png', type: 'IMAGE' }],
  ['image/webp', { ext: 'webp', type: 'IMAGE' }],
  ['video/mp4', { ext: 'mp4', type: 'VIDEO' }],
  ['video/quicktime', { ext: 'mov', type: 'VIDEO' }],
]);

/**
 * Chat attachment caps — deliberately smaller than Session 04's 50 MB / 500 MB
 * content-library ceilings. A DM is not the monetized catalogue: it is sent
 * casually and often, and there is no upload UI worth 500 MB of buffering here.
 */
export const MAX_MESSAGE_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAX_MESSAGE_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Sends are capped per authenticated user, not per IP — two subscribers behind
 * one NAT must not exhaust each other's budget, and one account must not earn a
 * fresh budget by changing IP. Same precedent as the payments checkout.
 */
const SEND_RATE_LIMIT = {
  max: 60,
  timeWindow: '1 minute',
  keyGenerator: (request: { user?: { userId?: string }; ip: string }) =>
    request.user?.userId ?? request.ip,
};

/** Reads are capped too, on the same key, so history is not a free firehose. */
const READ_RATE_LIMIT = {
  max: 120,
  timeWindow: '1 minute',
  keyGenerator: (request: { user?: { userId?: string }; ip: string }) =>
    request.user?.userId ?? request.ip,
};

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof MessagingError) {
    return reply.code(err.status).send({ error: err.message });
  }
  throw err;
}

export default async function messagingRoutes(
  app: FastifyInstance,
  opts: MessagingRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── POST /conversations/:modelId ──────────────────────────────────────────
  // Only a subscriber opens a conversation, and only with a model they hold an
  // ACTIVE subscription to. Idempotent: 201 the first time, 200 thereafter.
  app.post<{ Params: { modelId: string } }>(
    '/conversations/:modelId',
    {
      preHandler: [authenticate, authorize('subscriber')],
      config: { rateLimit: SEND_RATE_LIMIT },
    },
    async (request, reply) => {
      const parsed = modelIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
      }
      try {
        const { conversation, created } = await service.createConversation(
          request.user.userId,
          parsed.data.modelId,
        );
        return reply.code(created ? 201 : 200).send(conversation);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── GET /conversations ────────────────────────────────────────────────────
  // Either role: a model reads their inbox through the same endpoint. The
  // caller id comes from the JWT, so there is no other inbox to ask for.
  app.get(
    '/conversations',
    { preHandler: [authenticate], config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const result = await service.listConversations(request.user.userId);
      return reply.code(200).send(result);
    },
  );

  // ── GET /conversations/:conversationId/messages ───────────────────────────
  app.get<{ Params: { conversationId: string } }>(
    '/conversations/:conversationId/messages',
    { preHandler: [authenticate], config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const params = conversationIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_input', details: params.error.flatten() });
      }
      const query = messageHistoryQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'invalid_query', details: query.error.flatten() });
      }
      try {
        const result = await service.listMessages(
          request.user.userId,
          params.data.conversationId,
          query.data,
        );
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── POST /conversations/:conversationId/messages ──────────────────────────
  // Two transports, one code path: JSON `{ text }` for text-only, multipart
  // (`text` field + `file` part) when an attachment rides along. The text is
  // validated by the same schema either way, so the 4000-char ceiling cannot be
  // sidestepped by choosing the other content type.
  app.post<{ Params: { conversationId: string } }>(
    '/conversations/:conversationId/messages',
    { preHandler: [authenticate], config: { rateLimit: SEND_RATE_LIMIT } },
    async (request, reply) => {
      const params = conversationIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_input', details: params.error.flatten() });
      }

      let rawText: unknown;
      let fileBuffer: Buffer | null = null;
      let declaredMime = '';
      let truncated = false;

      if (request.isMultipart()) {
        // Override the global 10 MB multipart cap with the video ceiling; the
        // image cap is applied below, once the detected type is known. Past the
        // ceiling the stream truncates (throwFileSizeLimit is off) → 413.
        try {
          const parts = request.parts({
            limits: { fileSize: MAX_MESSAGE_VIDEO_BYTES, files: 1 },
          });
          for await (const part of parts) {
            if (part.type === 'file') {
              if (part.fieldname !== 'file') {
                return reply.code(400).send({ error: 'unexpected_file_field' });
              }
              fileBuffer = await part.toBuffer();
              truncated = part.file.truncated;
              declaredMime = part.mimetype;
            } else if (part.fieldname === 'text') {
              rawText = String(part.value);
            }
          }
        } catch {
          return reply.code(400).send({ error: 'malformed_multipart' });
        }
      } else {
        rawText = (request.body as { text?: unknown } | undefined)?.text;
      }

      const parsedBody = sendMessageBodySchema.safeParse(
        rawText === undefined ? {} : { text: rawText },
      );
      if (!parsedBody.success) {
        // `flatten()` reports only rule violations, never the submitted value —
        // a message body must not travel back out through an error payload.
        return reply.code(400).send({ error: 'invalid_input', details: parsedBody.error.flatten() });
      }

      let attachment;
      if (fileBuffer) {
        // Validate the bytes, not the header: sniff magic bytes, require the
        // declared Content-Type to agree, and confirm it is an allowed kind.
        const detected = await fileTypeFromBuffer(fileBuffer);
        const allowed = detected ? ALLOWED_ATTACHMENT_TYPES.get(detected.mime) : undefined;
        if (!detected || !allowed) {
          return reply.code(415).send({ error: 'unsupported_attachment_type' });
        }
        if (declaredMime !== detected.mime) {
          return reply.code(415).send({ error: 'attachment_content_type_mismatch' });
        }
        // A truncated stream means the 100 MB ceiling was hit; images cap lower.
        if (truncated) {
          return reply.code(413).send({ error: 'attachment_too_large' });
        }
        if (allowed.type === 'IMAGE' && fileBuffer.length > MAX_MESSAGE_IMAGE_BYTES) {
          return reply.code(413).send({ error: 'attachment_too_large' });
        }
        attachment = {
          buffer: fileBuffer,
          mimeType: detected.mime,
          sizeBytes: fileBuffer.length,
          ext: allowed.ext,
          type: allowed.type,
        };
      }

      try {
        const message = await service.sendMessage({
          senderId: request.user.userId,
          conversationId: params.data.conversationId,
          text: parsedBody.data.text,
          attachment,
        });
        return reply.code(201).send(message);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── GET /attachments/:messageId ───────────────────────────────────────────
  // The only route to an attachment's bytes, and it hands out a 60-second URL
  // rather than the storage key behind it.
  app.get<{ Params: { messageId: string } }>(
    '/attachments/:messageId',
    { preHandler: [authenticate], config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = messageIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.getAttachmentUrl(request.user.userId, parsed.data.messageId);
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── PATCH /conversations/:conversationId/read ─────────────────────────────
  app.patch<{ Params: { conversationId: string } }>(
    '/conversations/:conversationId/read',
    { preHandler: [authenticate], config: { rateLimit: SEND_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = conversationIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.markRead(request.user.userId, parsed.data.conversationId);
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
