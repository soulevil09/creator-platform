// HTTP layer for model onboarding. Owns request parsing, multipart handling,
// magic-byte file validation, and per-route rate limits; delegates persistence,
// storage, and consent rules to the onboarding service.
//
// Every route is MODEL-only: `authenticate` (valid access cookie) then
// `authorize('model')`. Storage keys never appear in responses — only signed
// URLs minted by the service.
import { fileTypeFromBuffer } from 'file-type';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { authenticate, authorize } from '../../middleware/auth.js';
import { OnboardingError, type OnboardingService } from './onboarding.service.js';
import { consentSchema, profileSchema } from './onboarding.schema.js';

export interface OnboardingRoutesOptions extends FastifyPluginOptions {
  service: OnboardingService;
}

/** Accepted upload MIME types → canonical file extension. */
const ALLOWED_IMAGE_TYPES = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

/** Map a thrown OnboardingError to its HTTP response; rethrow anything else. */
function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OnboardingError) {
    return reply.code(err.status).send({ error: err.message });
  }
  throw err;
}

// MODEL-only guard reused by every route in this module.
const modelOnly = { preHandler: [authenticate, authorize('model')] };

export default async function onboardingRoutes(
  app: FastifyInstance,
  opts: OnboardingRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // ── PUT /profile ──────────────────────────────────────────────────────────
  app.put(
    '/profile',
    { ...modelOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = profileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.upsertProfile(request.user.userId, parsed.data);
        return reply.code(result.created ? 201 : 200).send({
          profileId: result.profileId,
          displayName: result.displayName,
          country: result.country,
          currency: result.currency,
          aiConsent: result.aiConsent,
          tosAcceptedAt: result.tosAcceptedAt,
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── GET /profile ──────────────────────────────────────────────────────────
  app.get('/profile', { ...modelOnly }, async (request, reply) => {
    try {
      const profile = await service.getProfile(request.user.userId);
      return reply.code(200).send(profile);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── POST /consent ─────────────────────────────────────────────────────────
  app.post(
    '/consent',
    { ...modelOnly, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = consentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      try {
        const result = await service.setConsent(request.user.userId, parsed.data.aiConsent);
        return reply.code(200).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── POST /reference-images ────────────────────────────────────────────────
  app.post(
    '/reference-images',
    { ...modelOnly, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      if (!request.isMultipart()) {
        return reply.code(400).send({ error: 'Expected multipart/form-data' });
      }

      const part = await request.file();
      if (!part || part.fieldname !== 'image') {
        return reply.code(400).send({ error: 'Missing "image" file field' });
      }

      // Buffer the upload (multipart limit caps this at 10 MB). With
      // throwFileSizeLimit disabled, an over-limit stream is truncated and the
      // flag is set rather than throwing — we surface that as a 400.
      const buffer = await part.toBuffer();
      if (part.file.truncated) {
        return reply.code(400).send({ error: 'File exceeds the 10 MB limit' });
      }

      // Validate the *contents*, not just the declared header: sniff magic
      // bytes and require the declared Content-Type to match what we detected.
      const detected = await fileTypeFromBuffer(buffer);
      if (!detected || !ALLOWED_IMAGE_TYPES.has(detected.mime)) {
        return reply
          .code(400)
          .send({ error: 'Unsupported image type (allowed: jpeg, png, webp)' });
      }
      if (part.mimetype !== detected.mime) {
        return reply
          .code(400)
          .send({ error: 'Content-Type does not match file contents' });
      }

      try {
        const image = await service.addReferenceImage(request.user.userId, {
          buffer,
          mimeType: detected.mime,
          sizeBytes: buffer.length,
          ext: ALLOWED_IMAGE_TYPES.get(detected.mime)!,
        });
        return reply.code(201).send(image);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── DELETE /reference-images/:imageId ─────────────────────────────────────
  app.delete<{ Params: { imageId: string } }>(
    '/reference-images/:imageId',
    { ...modelOnly },
    async (request, reply) => {
      try {
        await service.deleteReferenceImage(request.user.userId, request.params.imageId);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
