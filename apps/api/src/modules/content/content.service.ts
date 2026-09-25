// Content lifecycle business logic: upload, publish toggle, tier-filtered
// listing, access resolution, watermarked serving, soft-delete, and the
// grant/revoke access primitives Session 05's payment webhooks call.
//
// This layer owns the DB, object storage, and image processing; it knows
// nothing about HTTP/multipart (the routes wire those). The single most
// important invariant: `storageKey` NEVER leaves this layer — only signed URLs
// (short TTL) and on-the-fly watermarked bytes do.
import { createId } from '@paralleldrive/cuid2';
import type {
  ContentListItem,
  ContentTier,
  ContentType,
  ContentUploadResponse,
  ReportContentResponse,
  ReportReason,
} from '@creator-platform/shared';
import type { Role } from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { PrismaTransactionClient } from '../wallet/wallet.service.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';
import { traceWatermarkLabel, type TraceRecorder } from '../protection/trace.js';

/** Thumbnail signed-URL TTL — capped at the session's 300s maximum. */
const THUMBNAIL_URL_TTL = 300;
/** Raw-video signed-URL TTL for the /serve endpoint. */
const VIDEO_SERVE_URL_TTL = 60;

/** The only grant reason that satisfies PREMIUM-tier access. */
const PREMIUM_GRANT_REASON = 'subscription_premium';

/** Typed error carrying the HTTP status the route should respond with. */
export class ContentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ContentError';
  }
}

export interface ContentServiceDeps {
  prisma: PrismaClient;
  storage: StorageClient;
  images: ImageProcessor;
  /** Bucket to read/write objects in (from STORAGE_BUCKET). */
  bucket: string;
  /** Session 09: mints the per-viewer trace code and writes its AuditLog row. */
  trace: TraceRecorder;
}

export interface UploadFile {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  /** File extension (no dot), derived from magic-byte detection. */
  ext: string;
}

export interface UploadMetadata {
  title: string;
  description?: string;
  type: ContentType;
  tier: ContentTier;
}

/** Requester identity for access resolution (undefined = anonymous). */
export interface Requester {
  userId?: string;
  role?: Role;
}

/** Image serve result: caller streams these bytes with no-store headers. */
export interface ImageServeResult {
  kind: 'image';
  buffer: Buffer;
  mimeType: string;
}

/**
 * Video serve result: caller returns the signed URL as JSON, plus the trace
 * code the player overlays (Session 09, Option B — see CLAUDE.md). The file
 * behind `signedUrl` is NOT watermarked: the code protects the viewing
 * surface, not the bytes, and someone who fetches the URL directly within its
 * 60 s TTL gets the unmarked original. That residual risk is accepted and
 * documented, not hidden.
 */
export interface VideoServeResult {
  kind: 'video';
  signedUrl: string;
  expiresIn: number;
  traceCode: string;
}

export type ServeResult = ImageServeResult | VideoServeResult;

function iso(date: Date): string {
  return date.toISOString();
}

/** A ContentAccess row is valid when it has no expiry or expires in the future. */
function accessIsActive(row: { expiresAt: Date | null }): boolean {
  return row.expiresAt === null || row.expiresAt.getTime() > Date.now();
}

export function createContentService({
  prisma,
  storage,
  images,
  bucket,
  trace,
}: ContentServiceDeps) {
  /**
   * Decide whether `requester` may view `content`, and why. Owner and admin
   * always pass; FREE is public; STANDARD needs any active grant; PREMIUM needs
   * an active PREMIUM subscription grant. Expired grants never count.
   */
  async function resolveAccess(
    content: { id: string; modelId: string; tier: ContentTier },
    requester: Requester,
  ): Promise<{ hasAccess: boolean; reason: string | null }> {
    if (requester.role === 'admin') {
      return { hasAccess: true, reason: 'admin' };
    }
    if (requester.userId && content.modelId === requester.userId) {
      return { hasAccess: true, reason: 'model_owner' };
    }
    if (content.tier === 'FREE') {
      return { hasAccess: true, reason: 'free' };
    }
    if (!requester.userId) {
      return { hasAccess: false, reason: null };
    }

    const grant = await prisma.contentAccess.findUnique({
      where: { contentId_userId: { contentId: content.id, userId: requester.userId } },
    });
    if (!grant || !accessIsActive(grant)) {
      return { hasAccess: false, reason: null };
    }
    if (content.tier === 'PREMIUM' && grant.grantReason !== PREMIUM_GRANT_REASON) {
      return { hasAccess: false, reason: null };
    }
    return { hasAccess: true, reason: grant.grantReason };
  }

  /**
   * Upsert a ContentAccess grant (refreshes grantReason + expiresAt on the
   * unique contentId+userId pair). Used by serve (owner audit) and by Session
   * 05's payment webhooks for subscription grants.
   *
   * `client` lets a caller enlist the grant in its own `$transaction`, so a
   * confirmed payment and the access it buys commit together. Defaults to the
   * service's own client for standalone calls.
   */
  async function grantContentAccess(
    params: {
      contentId: string;
      userId: string;
      grantReason: string;
      expiresAt?: Date | null;
    },
    client: PrismaTransactionClient = prisma,
  ) {
    const { contentId, userId, grantReason, expiresAt = null } = params;
    return client.contentAccess.upsert({
      where: { contentId_userId: { contentId, userId } },
      update: { grantReason, expiresAt },
      create: { contentId, userId, grantReason, expiresAt },
    });
  }

  return {
    grantContentAccess,

    /** Remove a user's access to a content item (no-op if none exists). */
    async revokeContentAccess(contentId: string, userId: string): Promise<void> {
      await prisma.contentAccess.deleteMany({ where: { contentId, userId } });
    },

    /**
     * Upload one content item. The caller (routes) has already magic-byte
     * validated the file and enforced size caps. Requires a verified model with
     * a profile that an admin has APPROVED (Session 11 — email verification
     * alone no longer unlocks monetization). Detects image dimensions; never
     * persists the watermark.
     */
    async upload(
      userId: string,
      meta: UploadMetadata,
      file: UploadFile,
    ): Promise<ContentUploadResponse> {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !user.isVerified) {
        throw new ContentError(403, 'Model must be verified to upload content');
      }
      const profile = await prisma.modelProfile.findUnique({ where: { userId } });
      if (!profile) {
        throw new ContentError(403, 'Model profile required before uploading content');
      }
      // Same 403 shape as the two gates above, with a machine code so a UI can
      // tell "verify your email" from "an admin has not approved you yet".
      if (profile.approvalStatus !== 'APPROVED') {
        throw new ContentError(403, 'model_not_approved');
      }

      let width: number | null = null;
      let height: number | null = null;
      if (meta.type === 'IMAGE') {
        const dims = await images.getDimensions(file.buffer);
        width = dims.width;
        height = dims.height;
      }

      const key = `content/${userId}/${createId()}.${file.ext}`;
      await storage.uploadFile(bucket, key, file.buffer, file.mimeType);

      const content = await prisma.content.create({
        data: {
          modelId: userId,
          title: meta.title,
          description: meta.description ?? null,
          type: meta.type,
          tier: meta.tier,
          storageKey: key,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          width,
          height,
          isPublished: false,
        },
      });

      return {
        contentId: content.id,
        title: content.title,
        tier: content.tier as ContentTier,
        type: content.type as ContentType,
        isPublished: content.isPublished,
      };
    },

    /**
     * Publish/unpublish content. A model may only toggle their own (403
     * otherwise); an admin may toggle anyone's — this is the moderation
     * unpublish lever (Session 11, D5), and the report-resolution path calls
     * this same function rather than a second unpublish implementation.
     */
    async setPublish(
      userId: string,
      contentId: string,
      publish: boolean,
      role: Role = 'model',
    ): Promise<{ contentId: string; isPublished: boolean }> {
      const content = await prisma.content.findUnique({ where: { id: contentId } });
      if (!content || content.deletedAt) {
        throw new ContentError(404, 'Content not found');
      }
      if (role !== 'admin' && content.modelId !== userId) {
        throw new ContentError(403, 'Forbidden');
      }
      const updated = await prisma.content.update({
        where: { id: contentId },
        data: { isPublished: publish },
      });
      return { contentId: updated.id, isPublished: updated.isPublished };
    },

    /**
     * List a model's published content filtered by the requester's access.
     * Anonymous requesters see only FREE; STANDARD/PREMIUM appear only when the
     * requester (or owner/admin) can access them. `storageKey` is never read
     * into the response; thumbnails are fresh signed URLs minted in parallel.
     */
    async listModelContent(
      modelId: string,
      requester: Requester,
      query: { page: number; limit: number; type?: ContentType; tier?: ContentTier },
    ): Promise<{ items: ContentListItem[]; page: number; limit: number }> {
      const rows = await prisma.content.findMany({
        where: {
          modelId,
          deletedAt: null,
          isPublished: true,
          ...(query.type ? { type: query.type } : {}),
          ...(query.tier ? { tier: query.tier } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });

      const resolved = await Promise.all(
        rows.map(async (row) => {
          const { hasAccess } = await resolveAccess(
            { id: row.id, modelId: row.modelId, tier: row.tier as ContentTier },
            requester,
          );
          return { row, hasAccess };
        }),
      );

      // Visibility: FREE is always listed; gated tiers only when accessible.
      const visible = resolved.filter(
        ({ row, hasAccess }) => row.tier === 'FREE' || hasAccess,
      );

      const start = (query.page - 1) * query.limit;
      const pageRows = visible.slice(start, start + query.limit);

      const items: ContentListItem[] = await Promise.all(
        pageRows.map(async ({ row, hasAccess }) => ({
          contentId: row.id,
          title: row.title,
          type: row.type as ContentType,
          tier: row.tier as ContentTier,
          isPublished: row.isPublished,
          // Signed URL only when the requester may view it; null otherwise.
          // (`storageKey` is only ever null on a purged soft-deleted row, which
          // the `deletedAt: null` filter above already excludes.)
          thumbnailUrl:
            hasAccess && row.storageKey !== null
              ? await storage.getSignedUrl(bucket, row.storageKey, THUMBNAIL_URL_TTL)
              : null,
          hasAccess,
          viewCount: row.viewCount,
          createdAt: iso(row.createdAt),
        })),
      );

      return { items, page: query.page, limit: query.limit };
    },

    /**
     * Resolve content delivery for an authenticated requester. Images are
     * fetched, watermarked with the platform brand + a per-viewer forensic
     * trace code (Session 09 — never the requester's email or id), and returned
     * as bytes (caller streams them with Cache-Control: no-store). Videos
     * return a short-lived signed URL plus the same kind of trace code for the
     * player to overlay. Either way one AuditLog row records who was served
     * which code. 403 when the requester lacks access. viewCount is bumped
     * fire-and-forget.
     */
    async serve(contentId: string, requester: Requester): Promise<ServeResult> {
      const content = await prisma.content.findUnique({ where: { id: contentId } });
      if (!content || content.deletedAt || content.storageKey === null) {
        throw new ContentError(404, 'Content not found');
      }

      const access = await resolveAccess(
        { id: content.id, modelId: content.modelId, tier: content.tier as ContentTier },
        requester,
      );
      if (!access.hasAccess) {
        throw new ContentError(403, 'Forbidden');
      }

      // Record/refresh the owner's access row for audit (spec §5). Other grant
      // reasons are written by Session 05's webhook, not here.
      if (access.reason === 'model_owner' && requester.userId) {
        await grantContentAccess({
          contentId: content.id,
          userId: requester.userId,
          grantReason: 'model_owner',
        });
      }

      // Fire-and-forget view count bump — must not delay delivery.
      void prisma.content
        .update({ where: { id: content.id }, data: { viewCount: { increment: 1 } } })
        .catch(() => {});

      // `authenticate` guarantees a userId on this path; the guard keeps the
      // type honest without inventing an anonymous trace.
      if (!requester.userId) {
        throw new ContentError(401, 'Unauthorized');
      }
      // The trace is issued (and audited) before the bytes leave — the audit
      // row is the only way a code on a leaked file resolves to a viewer.
      const { traceCode } = await trace.issue({
        entity: 'Content',
        entityId: content.id,
        viewerId: requester.userId,
      });

      if (content.type === 'VIDEO') {
        const signedUrl = await storage.getSignedUrl(
          bucket,
          content.storageKey,
          VIDEO_SERVE_URL_TTL,
        );
        return { kind: 'video', signedUrl, expiresIn: VIDEO_SERVE_URL_TTL, traceCode };
      }

      const raw = await storage.getObject(bucket, content.storageKey);
      const watermarked = await images.watermark(
        raw,
        traceWatermarkLabel(traceCode),
        content.mimeType,
      );
      return { kind: 'image', buffer: watermarked, mimeType: content.mimeType };
    },

    /**
     * Flag a content item for moderation (Session 11, D5). Any authenticated
     * user may report anything that exists and is not deleted — whoever can
     * see a listing can report it. The partial unique index
     * (`Report_one_pending_per_reporter_content`) is the only guard against a
     * duplicate: a second report while the first is still PENDING rejects at
     * the database and is answered as a 200 no-op with the existing row, so a
     * flood of repeats never becomes a pile of rows. Once resolved, the same
     * viewer may report the item again.
     */
    async reportContent(
      reporterId: string,
      contentId: string,
      input: { reason: ReportReason; details?: string },
    ): Promise<{ report: ReportContentResponse; created: boolean }> {
      const content = await prisma.content.findUnique({ where: { id: contentId } });
      if (!content || content.deletedAt) {
        throw new ContentError(404, 'Content not found');
      }

      const toResponse = (row: {
        id: string;
        contentId: string;
        status: string;
        createdAt: Date;
      }): ReportContentResponse => ({
        reportId: row.id,
        contentId: row.contentId,
        status: row.status as ReportContentResponse['status'],
        createdAt: iso(row.createdAt),
      });

      try {
        const row = await prisma.report.create({
          data: {
            contentId,
            reporterId,
            reason: input.reason,
            details: input.details ?? null,
          },
        });
        return { report: toResponse(row), created: true };
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }

      // The index refused it: there is already a PENDING report from this
      // viewer on this item. Return that one, unchanged.
      const existing = await prisma.report.findFirst({
        where: { contentId, reporterId, status: 'PENDING' },
      });
      if (!existing) {
        // The pending row resolved between the failed insert and this read;
        // the caller can simply retry. Vanishingly rare, and never a 500.
        throw new ContentError(409, 'report_conflict');
      }
      return { report: toResponse(existing), created: false };
    },

    /**
     * Soft-delete content: mark `deletedAt` and unpublish. Models may only
     * delete their own; admins may delete any. The underlying object is purged
     * by the daily storage-cleanup sweep (Session 09), which then nulls
     * `storageKey`.
     */
    async softDelete(userId: string, role: Role, contentId: string): Promise<void> {
      const content = await prisma.content.findUnique({ where: { id: contentId } });
      if (!content || content.deletedAt) {
        throw new ContentError(404, 'Content not found');
      }
      if (role !== 'admin' && content.modelId !== userId) {
        throw new ContentError(403, 'Forbidden');
      }
      await prisma.content.update({
        where: { id: contentId },
        data: { deletedAt: new Date(), isPublished: false },
      });
    },
  };
}

export type ContentService = ReturnType<typeof createContentService>;
