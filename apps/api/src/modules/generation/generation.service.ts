// =============================================================================
// AI image personalization business logic (Session 08).
//
// This layer owns the database, the credit wallet, object storage, image
// processing and the provider seam; it knows nothing about HTTP (the routes
// wire that). The invariants that live here rather than at the edges:
//
//   1. The content-safety gate runs before any credit is touched and before
//      any row is written. A rejected prompt leaves nothing behind except an
//      AuditLog row carrying the prompt's hash — never its text.
//
//   2. `ModelProfile.aiConsent` is read live on every request, never cached.
//      A model who revoked consent since onboarding cannot be generated
//      against, whatever a client remembers (the Session 07 discipline for
//      `Subscription.status`, applied to consent).
//
//   3. The debit and the PENDING row commit together, and the refund and the
//      FAILED row commit together. There is no instant at which credits are
//      gone with no job to show for it, or a job is FAILED with the credits
//      still gone. The refund is guarded by a compare-and-set on the status
//      (`WHERE id = ? AND status = 'PENDING'`), so it can run at most once per
//      job however many times the failure path is entered.
//
//   4. The anchor prompt is built here, handed to the provider, and dropped.
//      It is not a field on any type this module returns, not a column, and
//      not an argument to any log call.
//
//   5. `storageKey` NEVER leaves this layer — same rule as `Content.storageKey`
//      (Session 04) and `Message.attachmentStorageKey` (Session 07). Delivery
//      is a short-TTL signed URL or the watermarked byte stream, nothing else.
//
//   6. A non-owner, an unknown id, and an expired image are all the same 404.
//      404 not 403: a 403 confirms the id exists (Session 06/07 reasoning).
// =============================================================================
import { createId } from '@paralleldrive/cuid2';
import { fileTypeFromBuffer } from 'file-type';
import {
  GENERATION_CUSTOM_PROMPT_COST,
  GENERATION_PRESETS,
  findGenerationPreset,
  type CreateGenerationResponse,
  type GenerationDetailResponse,
  type GenerationListItem,
  type GenerationListResponse,
  type GenerationMode,
  type GenerationPreset,
  type GenerationStatus,
} from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import { InsufficientCreditsError, type WalletService } from '../wallet/wallet.service.js';
import { traceWatermarkLabel, type TraceRecorder } from '../protection/trace.js';
import { buildAnchorPrompt } from './anchor.js';
import { checkPromptSafety, hashPrompt } from './safety.js';
import { presetPromptFor } from './presets.js';
import { AIProviderError, type IAIProvider } from './provider.interface.js';
import type { CreateGenerationInput } from './generation.schema.js';

/**
 * Reference-image signed-URL TTL. Must outlive the provider call (the
 * provider fetches them itself, possibly after a cold boot), so it is the
 * 300 s ceiling Session 03/04 use rather than the 60 s attachment TTL.
 */
export const REFERENCE_IMAGE_URL_TTL = 300;
/** Generated-image signed-URL TTL for list/detail — same 300 s as content thumbnails. */
export const GENERATION_IMAGE_URL_TTL = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Output encodings we will store, keyed by sniffed MIME type → extension. */
const ALLOWED_OUTPUT_TYPES = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

/** Typed error carrying the HTTP status the route should answer with. */
export class GenerationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

/** The subset of a pino-style logger this module calls. */
export interface GenerationLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const noopLogger: GenerationLogger = { info() {}, warn() {} };

export interface GenerationServiceDeps {
  prisma: PrismaClient;
  storage: StorageClient;
  images: ImageProcessor;
  /** Bucket to read/write objects in (from STORAGE_BUCKET). */
  bucket: string;
  /** Session 05's wallet — the only thing that moves credits. */
  wallet: WalletService;
  /** Factory rather than instance, so the adapter is resolved per call like payments. */
  getProvider: () => IAIProvider;
  /** Days a completed image stays servable (from GENERATION_IMAGE_RETENTION_DAYS). */
  retentionDays: number;
  /** Session 09: mints the per-viewer trace code and writes its AuditLog row. */
  trace: TraceRecorder;
  logger?: GenerationLogger;
}

/** Image serve result: caller streams these bytes with no-store headers. */
export interface GenerationImageResult {
  buffer: Buffer;
  mimeType: string;
}

/** The GenerationJob columns this module reads. */
interface GenerationJobRow {
  id: string;
  subscriberId: string;
  modelId: string;
  mode: 'PRESET' | 'CUSTOM';
  presetId: string | null;
  userPrompt: string | null;
  creditsCost: number;
  status: GenerationStatus;
  storageKey: string | null;
  providerJobId: string | null;
  errorMessage: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

function isExpired(row: Pick<GenerationJobRow, 'expiresAt'>, now = Date.now()): boolean {
  return row.expiresAt !== null && row.expiresAt.getTime() <= now;
}

/** COMPLETED, with an object behind it, and not yet past `expiresAt`. */
function isServable(row: GenerationJobRow): row is GenerationJobRow & { storageKey: string } {
  return row.status === 'COMPLETED' && row.storageKey !== null && !isExpired(row);
}

/** MIME type of a stored object, from the extension the service itself chose. */
function mimeTypeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1);
  for (const [mime, candidate] of ALLOWED_OUTPUT_TYPES) {
    if (candidate === ext) return mime;
  }
  return 'application/octet-stream';
}

/**
 * Project a job row onto the wire shape. This is the ONLY place a job becomes
 * client-visible JSON, which is what makes "the storage key is never
 * serialized" and "the anchor prompt is never serialized" properties of the
 * module rather than habits — neither is a field of the output type.
 */
function toListItem(row: GenerationJobRow, imageUrl: string | null): GenerationListItem {
  return {
    generationId: row.id,
    modelId: row.modelId,
    mode: row.mode.toLowerCase() as GenerationMode,
    presetId: row.presetId,
    status: row.status,
    creditsCost: row.creditsCost,
    imageUrl,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(row: GenerationJobRow, imageUrl: string | null): GenerationDetailResponse {
  return { ...toListItem(row, imageUrl), userPrompt: row.userPrompt };
}

/**
 * The short internal code a failure is recorded under. Never the provider's
 * message or payload: Replicate echoes the prediction input back, and the
 * job row must not become the one place the anchor prompt is persisted.
 */
function failureCode(err: unknown): string {
  if (err instanceof AIProviderError) return `provider_${err.reason}`;
  return 'internal_error';
}

export function createGenerationService({
  prisma,
  storage,
  images,
  bucket,
  wallet,
  getProvider,
  retentionDays,
  trace,
  logger = noopLogger,
}: GenerationServiceDeps) {
  /**
   * Load a job the caller owns. Unknown id and someone else's id are the
   * same 404 — see invariant 6 at the top of the file.
   */
  async function loadOwned(subscriberId: string, id: string): Promise<GenerationJobRow> {
    const row = (await prisma.generationJob.findUnique({
      where: { id },
    })) as GenerationJobRow | null;
    if (!row || row.subscriberId !== subscriberId) {
      throw new GenerationError(404, 'generation_not_found');
    }
    return row;
  }

  /** Signed URL for a servable job's image; null for anything else. */
  async function signedImageUrl(row: GenerationJobRow): Promise<string | null> {
    if (!isServable(row)) return null;
    return storage.getSignedUrl(bucket, row.storageKey, GENERATION_IMAGE_URL_TTL);
  }

  /**
   * Mark a job FAILED and give the credits back, atomically. The status flip
   * is a compare-and-set on PENDING: if some other path already moved the row
   * on, this matches zero rows and refunds nothing — a job is refunded at most
   * once, by construction, not by a flag.
   */
  async function failAndRefund(
    jobId: string,
    subscriberId: string,
    creditsCost: number,
    reason: string,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.generationJob.updateMany({
        where: { id: jobId, status: 'PENDING' },
        data: { status: 'FAILED', errorMessage: reason },
      });
      if (claimed.count === 0) return;

      await wallet.addCredits(
        subscriberId,
        creditsCost,
        {
          reason: 'ai_generation_refund',
          actorId: null,
          relatedEntity: 'GenerationJob',
          relatedEntityId: jobId,
        },
        tx,
      );
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'generation.failed',
          entity: 'GenerationJob',
          entityId: jobId,
          metadata: { subscriberId, reason, creditsRefunded: creditsCost },
        },
      });
    });
  }

  return {
    /** The server-side catalog: what a client may pick, at what cost. */
    listPresets(): GenerationPreset[] {
      return GENERATION_PRESETS.map(({ id, label, creditsCost }) => ({ id, label, creditsCost }));
    },

    /**
     * One synchronous generation, start to finish. The steps and their order
     * are the spec's: model → live consent → cost → safety gate → in-flight
     * check → debit + PENDING row → provider → COMPLETED (or FAILED + refund).
     */
    async create(
      subscriberId: string,
      input: CreateGenerationInput,
    ): Promise<CreateGenerationResponse> {
      // 1. The target must be a MODEL with a profile.
      const model = await prisma.user.findUnique({ where: { id: input.modelId } });
      if (!model || model.role !== 'MODEL') {
        throw new GenerationError(404, 'model_not_found');
      }
      const profile = await prisma.modelProfile.findUnique({ where: { userId: input.modelId } });
      if (!profile) {
        throw new GenerationError(404, 'model_not_found');
      }

      // 2. Live consent check — read fresh on this request, never cached. A
      //    model with consent but no reference images is not generatable
      //    either: text alone cannot anchor a likeness, and there is nothing
      //    honest to anchor on, so the same "not enabled" answer applies.
      if (profile.aiConsent !== true) {
        throw new GenerationError(403, 'ai_not_enabled');
      }
      const references = await prisma.referenceImage.findMany({
        where: { modelProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
      });
      if (references.length === 0) {
        throw new GenerationError(403, 'ai_not_enabled');
      }

      // 3. Cost is resolved from the catalog, never from the request.
      let creditsCost: number;
      let presetId: string | null = null;
      let userPrompt: string;
      let scenePrompt: string;
      if (input.mode === 'preset') {
        const preset = findGenerationPreset(input.presetId);
        const fragment = presetPromptFor(input.presetId);
        if (!preset || fragment === undefined) {
          throw new GenerationError(400, 'unknown_preset');
        }
        creditsCost = preset.creditsCost;
        presetId = preset.id;
        userPrompt = preset.label;
        scenePrompt = fragment;
      } else {
        creditsCost = GENERATION_CUSTOM_PROMPT_COST;
        userPrompt = input.customPrompt;
        scenePrompt = input.customPrompt;
      }

      // 4. Content-safety gate — before any credit is touched or row written.
      //    The model's own name is the one likeness that has been consented
      //    to, so it is exempt from the real-person check; nothing else is.
      if (input.mode === 'custom') {
        const verdict = checkPromptSafety(input.customPrompt, {
          allowedNames: [profile.displayName, model.displayName],
        });
        if (!verdict.ok) {
          await prisma.auditLog.create({
            data: {
              actorId: subscriberId,
              action: 'generation.prompt_rejected',
              entity: 'User',
              entityId: subscriberId,
              metadata: {
                modelId: input.modelId,
                category: verdict.category,
                promptHash: hashPrompt(input.customPrompt),
              },
            },
          });
          throw new GenerationError(400, 'prompt_rejected');
        }
      }

      // 5. One in-flight generation per subscriber. This read is the fast
      //    path; the partial unique index in the migration is the guard that
      //    holds when two requests race past it (the insert below rejects and
      //    rolls the debit back with it).
      const inflight = await prisma.generationJob.findFirst({
        where: { subscriberId, status: 'PENDING' },
      });
      if (inflight) {
        throw new GenerationError(429, 'generation_in_progress');
      }

      // 6 + 7. Debit and PENDING row, one transaction. The id is minted here
      //    so the debit's audit row can point at the job it funded.
      const jobId = createId();
      try {
        await prisma.$transaction(async (tx) => {
          await wallet.debitCredits(
            subscriberId,
            creditsCost,
            {
              reason: 'ai_generation',
              actorId: subscriberId,
              relatedEntity: 'GenerationJob',
              relatedEntityId: jobId,
            },
            tx,
          );
          await tx.generationJob.create({
            data: {
              id: jobId,
              subscriberId,
              modelId: input.modelId,
              mode: input.mode === 'preset' ? 'PRESET' : 'CUSTOM',
              presetId,
              userPrompt,
              creditsCost,
              status: 'PENDING',
            },
          });
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          throw new GenerationError(402, 'insufficient_credits');
        }
        if ((err as { code?: string }).code === 'P2002') {
          throw new GenerationError(429, 'generation_in_progress');
        }
        throw err;
      }

      // 8. Anchor + provider call. The signed URLs are minted now, not
      //    earlier, so their TTL is spent on the provider call and not on the
      //    checks above.
      const referenceImageUrls = await Promise.all(
        references.map((image) =>
          storage.getSignedUrl(bucket, image.storageKey, REFERENCE_IMAGE_URL_TTL),
        ),
      );
      const anchor = buildAnchorPrompt({ displayName: profile.displayName }, referenceImageUrls);

      let completed: GenerationJobRow;
      try {
        const provider = getProvider();
        const result = await provider.generateImage({
          anchorPrompt: anchor.anchorPrompt,
          userPrompt: scenePrompt,
          referenceImageUrls: anchor.referenceImageUrls,
        });

        // 9. Sniff, store raw (watermarking happens at serve time), complete.
        const detected = await fileTypeFromBuffer(result.imageBuffer);
        const ext = detected ? ALLOWED_OUTPUT_TYPES.get(detected.mime) : undefined;
        if (!detected || !ext) {
          throw new AIProviderError(
            provider.name,
            'invalid_response',
            'provider returned a payload that is not a supported image',
          );
        }
        const storageKey = `generations/${subscriberId}/${createId()}.${ext}`;
        await storage.uploadFile(bucket, storageKey, result.imageBuffer, detected.mime);

        completed = (await prisma.generationJob.update({
          where: { id: jobId },
          data: {
            status: 'COMPLETED',
            storageKey,
            providerJobId: result.providerJobId,
            expiresAt: new Date(Date.now() + retentionDays * DAY_MS),
          },
        })) as GenerationJobRow;
      } catch (err) {
        // 10. Anything after the debit that stops an image reaching storage
        //     refunds — provider failure, timeout, unusable output, storage
        //     error. The code recorded is ours, never the provider's text.
        const reason = failureCode(err);
        await failAndRefund(jobId, subscriberId, creditsCost, reason);
        logger.warn(
          { jobId, modelId: input.modelId, reason },
          'generation failed; credits refunded',
        );
        throw new GenerationError(502, 'generation_failed');
      }

      logger.info(
        { jobId, modelId: input.modelId, providerJobId: completed.providerJobId },
        'generation completed',
      );
      return toDetail(completed, await signedImageUrl(completed));
    },

    /**
     * The caller's own gallery, newest first. One `findMany`; signed URLs are
     * minted in parallel for the servable rows only — no N+1. Cursor-based
     * over `(createdAt DESC, id DESC)` exactly like the messaging history read.
     */
    async list(
      subscriberId: string,
      query: { before?: string; limit: number },
    ): Promise<GenerationListResponse> {
      const rows = (await prisma.generationJob.findMany({
        where: { subscriberId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
      })) as GenerationJobRow[];

      const generations = await Promise.all(
        rows.map(async (row) => toListItem(row, await signedImageUrl(row))),
      );
      return {
        generations,
        nextCursor: rows.length === query.limit ? rows[rows.length - 1].id : null,
      };
    },

    /** One job, owner only. An expired image is a 404 even to its owner. */
    async get(subscriberId: string, id: string): Promise<GenerationDetailResponse> {
      const row = await loadOwned(subscriberId, id);
      if (isExpired(row)) {
        throw new GenerationError(404, 'generation_not_found');
      }
      return toDetail(row, await signedImageUrl(row));
    },

    /**
     * The image bytes, watermarked on the fly with Session 04's processor —
     * the stored object is never watermarked, and the watermarked bytes are
     * per-requester so the route sends them with `Cache-Control: no-store`.
     * The mark is the brand + a forensic trace code (Session 09), never the
     * subscriber's email or id; the code resolves to them only through the
     * AuditLog row `trace.issue` writes.
     */
    async serveImage(subscriberId: string, id: string): Promise<GenerationImageResult> {
      const row = await loadOwned(subscriberId, id);
      if (!isServable(row)) {
        throw new GenerationError(404, 'generation_not_found');
      }

      const { traceCode } = await trace.issue({
        entity: 'GenerationJob',
        entityId: row.id,
        viewerId: subscriberId,
      });
      const raw = await storage.getObject(bucket, row.storageKey);
      const mimeType = mimeTypeForKey(row.storageKey);
      const buffer = await images.watermark(raw, traceWatermarkLabel(traceCode), mimeType);
      return { buffer, mimeType };
    },
  };
}

export type GenerationService = ReturnType<typeof createGenerationService>;
