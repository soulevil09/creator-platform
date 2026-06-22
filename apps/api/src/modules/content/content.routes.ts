// HTTP layer for content management. Owns multipart parsing, magic-byte file
// validation, per-type size caps, rate limits, and response shaping; delegates
// all persistence / storage / image work to the content service.
//
// Security invariant enforced here: `storageKey` is never read into a response.
// The service returns only signed URLs or watermarked bytes, and these handlers
// pass those through verbatim.
import { fileTypeFromBuffer } from 'file-type';
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { authenticate, authorize } from '../../middleware/auth.js';
import { ContentError, type ContentService } from './content.service.js';
import { listQuerySchema, publishSchema, uploadMetadataSchema } from './content.schema.js';

export interface ContentRoutesOptions extends FastifyPluginOptions {
  service: ContentService;
}

/** Accepted upload MIME types → { ext, category }. */
const ALLOWED_TYPES = new Map<string, { ext: string; category: 'IMAGE' | 'VIDEO' }>([
  ['image/jpeg', { ext: 'jpg', category: 'IMAGE' }],
  ['image/png', { ext: 'png', category: 'IMAGE' }],
  ['image/webp', { ext: 'webp', category: 'IMAGE' }],
  ['video/mp4', { ext: 'mp4', category: 'VIDEO' }],
  ['video/quicktime', { ext: 'mov', category: 'VIDEO' }],
]);

/** Per-type size caps (bytes). 413 when exceeded. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB

/** Map a thrown ContentError to its HTTP response; rethrow anything else. */
function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ContentError) {
    return reply.code(err.status).send({ error: err.message });
  }
  throw err;
}

/**
 * Optional auth: verify the access cookie if present, but never reject. Leaves
 * `request.user` unset for anonymous callers so the list endpoint can downgrade
 * to FREE-only visibility.
 */
async function optionalAuthenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.accessJwtVerify();
  } catch {
    // Anonymous — request.user stays undefined.
  }
}

const modelOnly = { preHandler: [authenticate, authorize('model')] };

export default async function contentRoutes(
  app: FastifyInstance,
  opts: ContentRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── POST /upload ──────────────────────────────────────────────────────────
  app.post(
    '/upload',
    { ...modelOnly, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      if (!request.isMultipart()) {
        return reply.code(400).send({ error: 'Expected multipart/form-data' });
      }

      const fields: Record<string, string> = {};
      let fileBuffer: Buffer | null = null;
      let declaredMime = '';
      let truncated = false;

      // Override the global 10 MB multipart cap with the video ceiling; the
      // image-specific cap is enforced after we know the detected type. Beyond
      // the ceiling the stream truncates (throwFileSizeLimit is off) → 413.
      try {
        const parts = request.parts({ limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } });
        for await (const part of parts) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file') {
              return reply.code(400).send({ error: 'Unexpected file field' });
            }
            fileBuffer = await part.toBuffer();
            truncated = part.file.truncated;
            declaredMime = part.mimetype;
          } else {
            fields[part.fieldname] = String(part.value);
          }
        }
      } catch {
        return reply.code(400).send({ error: 'Malformed multipart upload' });
      }

      if (!fileBuffer) {
        return reply.code(400).send({ error: 'Missing "file" field' });
      }

      const parsed = uploadMetadataSchema.safeParse(fields);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }

      // Validate the bytes, not the header alone: sniff magic bytes, require the
      // declared Content-Type to match, and confirm the file is an allowed type.
      const detected = await fileTypeFromBuffer(fileBuffer);
      const allowed = detected ? ALLOWED_TYPES.get(detected.mime) : undefined;
      if (!detected || !allowed) {
        return reply.code(400).send({
          error: 'Unsupported file type (allowed: jpeg, png, webp, mp4, quicktime)',
        });
      }
      if (declaredMime !== detected.mime) {
        return reply.code(400).send({ error: 'Content-Type does not match file contents' });
      }
      // The declared `type` field must agree with what the bytes actually are.
      if (parsed.data.type !== allowed.category) {
        return reply
          .code(400)
          .send({ error: `Declared type ${parsed.data.type} does not match file contents` });
      }

      // Size caps. A truncated stream means the 500 MB ceiling was hit (video);
      // images additionally cap at 50 MB.
      if (truncated) {
        return reply.code(413).send({ error: 'File exceeds the maximum allowed size' });
      }
      if (allowed.category === 'IMAGE' && fileBuffer.length > MAX_IMAGE_BYTES) {
        return reply.code(413).send({ error: 'Image exceeds the 50 MB limit' });
      }

      try {
        const result = await service.upload(
          request.user.userId,
          {
            title: parsed.data.title,
            description: parsed.data.description,
            type: parsed.data.type,
            tier: parsed.data.tier,
            ppvPriceCents: parsed.data.ppvPriceCents,
          },
          {
            buffer: fileBuffer,
            mimeType: detected.mime,
            sizeBytes: fileBuffer.length,
            ext: allowed.ext,
          },
        );
        return reply.code(201).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── PATCH /:contentId/publish ─────────────────────────────────────────────
  app.patch<{ Params: { contentId: string } }>(
    '/:contentId/publish',
    { ...modelOnly },
    async (request, reply) => {
      const parsed = publishSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.setPublish(
          request.user.userId,
          request.params.contentId,
          parsed.data.publish,
        );
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── GET /model/:modelId (optional auth) ───────────────────────────────────
  app.get<{ Params: { modelId: string } }>(
    '/model/:modelId',
    { preHandler: [optionalAuthenticate] },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid query', details: parsed.error.flatten() });
      }
      const requester = request.user
        ? { userId: request.user.userId, role: request.user.role }
        : {};
      try {
        const result = await service.listModelContent(request.params.modelId, requester, parsed.data);
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── GET /:contentId/serve (authenticated) ─────────────────────────────────
  app.get<{ Params: { contentId: string } }>(
    '/:contentId/serve',
    { preHandler: [authenticate] },
    async (request, reply) => {
      try {
        const result = await service.serve(request.params.contentId, {
          userId: request.user.userId,
          role: request.user.role,
        });
        if (result.kind === 'video') {
          return reply
            .code(200)
            .send({ signedUrl: result.signedUrl, expiresIn: result.expiresIn });
        }
        // Per-user watermarked bytes must never be cached.
        return reply
          .code(200)
          .header('Content-Type', result.mimeType)
          .header('Content-Disposition', 'inline')
          .header('Cache-Control', 'no-store')
          .send(result.buffer);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── DELETE /:contentId (model or admin) ───────────────────────────────────
  app.delete<{ Params: { contentId: string } }>(
    '/:contentId',
    { preHandler: [authenticate, authorize('model', 'admin')] },
    async (request, reply) => {
      try {
        await service.softDelete(
          request.user.userId,
          request.user.role,
          request.params.contentId,
        );
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
