// Content lifecycle business logic: upload, publish toggle, tier-filtered
// listing, access resolution, watermarked serving, soft-delete, and the
// grant/revoke access primitives Session 05's Stripe webhooks will call.
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
} from '@creator-platform/shared';
import type { Role } from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ImageProcessor } from '../../lib/image.js';

/** Thumbnail signed-URL TTL — capped at the session's 300s maximum. */
const THUMBNAIL_URL_TTL = 300;
/** Raw-video signed-URL TTL for the /serve endpoint. */
const VIDEO_SERVE_URL_TTL = 60;
/** Platform label burned into the per-user watermark. */
const WATERMARK_BRAND = 'CreatorPlatform';

/** Grant reasons that satisfy PREMIUM-tier access. */
const PREMIUM_GRANT_REASONS = new Set(['subscription_premium', 'ppv_purchase']);

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
  ppvPriceCents?: number;
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

/** Video serve result: caller returns the signed URL as JSON. */
export interface VideoServeResult {
  kind: 'video';
  signedUrl: string;
  expiresIn: number;
}

export type ServeResult = ImageServeResult | VideoServeResult;

function iso(date: Date): string {
  return date.toISOString();
}

/** A ContentAccess row is valid when it has no expiry or expires in the future. */
function accessIsActive(row: { expiresAt: Date | null }): boolean {
  return row.expiresAt === null || row.expiresAt.getTime() > Date.now();
}

export function createContentService({ prisma, storage, images, bucket }: ContentServiceDeps) {
  /**
   * Decide whether `requester` may view `content`, and why. Owner and admin
   * always pass; FREE is public; STANDARD needs any active grant; PREMIUM needs
   * a premium/ppv grant. Expired grants never count.
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
    if (content.tier === 'PREMIUM' && !PREMIUM_GRANT_REASONS.has(grant.grantReason)) {
      return { hasAccess: false, reason: null };
    }
    return { hasAccess: true, reason: grant.grantReason };
  }

  /**
   * Upsert a ContentAccess grant (refreshes grantReason + expiresAt on the
   * unique contentId+userId pair). Used by serve (owner audit) now and by
   * Session 05's Stripe webhooks for subscription/PPV grants.
   */
  async function grantContentAccess(params: {
    contentId: string;
    userId: string;
    grantReason: string;
    expiresAt?: Date | null;
  }) {
    const { contentId, userId, grantReason, expiresAt = null } = params;
    return prisma.contentAccess.upsert({
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
     * a profile. Detects image dimensions; never persists the watermark.
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
          ppvPriceCents: meta.ppvPriceCents ?? null,
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

    /** Publish/unpublish the model's own content (403 if not the owner). */
    async setPublish(
      userId: string,
      contentId: string,
      publish: boolean,
    ): Promise<{ contentId: string; isPublished: boolean }> {
      const content = await prisma.content.findUnique({ where: { id: contentId } });
      if (!content || content.deletedAt) {
        throw new ContentError(404, 'Content not found');
      }
      if (content.modelId !== userId) {
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
          thumbnailUrl: hasAccess
            ? await storage.getSignedUrl(bucket, row.storageKey, THUMBNAIL_URL_TTL)
            : null,
          hasAccess,
          ppvPriceCents: row.ppvPriceCents ?? null,
          viewCount: row.viewCount,
          createdAt: iso(row.createdAt),
        })),
      );

      return { items, page: query.page, limit: query.limit };
    },

    /**
     * Resolve content delivery for an authenticated requester. Images are
     * fetched, watermarked with the platform brand + the requester's email, and
     * returned as bytes (caller streams them with Cache-Control: no-store).
     * Videos return a short-lived signed URL (no server-side watermark at MVP).
     * 403 when the requester lacks access. viewCount is bumped fire-and-forget.
     */
    async serve(contentId: string, requester: Requester): Promise<ServeResult> {
      const content = await prisma.content.findUnique({ where: { id: contentId } });
      if (!content || content.deletedAt) {
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

      if (content.type === 'VIDEO') {
        const signedUrl = await storage.getSignedUrl(
          bucket,
          content.storageKey,
          VIDEO_SERVE_URL_TTL,
        );
        return { kind: 'video', signedUrl, expiresIn: VIDEO_SERVE_URL_TTL };
      }

      const raw = await storage.getObject(bucket, content.storageKey);
      const label = requester.userId
        ? `${WATERMARK_BRAND} • ${await emailFor(prisma, requester.userId)}`
        : WATERMARK_BRAND;
      const watermarked = await images.watermark(raw, label, content.mimeType);
      return { kind: 'image', buffer: watermarked, mimeType: content.mimeType };
    },

    /**
     * Soft-delete content: mark `deletedAt` and unpublish. Models may only
     * delete their own; admins may delete any. The underlying object is left in
     * storage for a future cleanup job (out of scope).
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

/** Fetch a user's email for the watermark label; falls back to the id. */
async function emailFor(prisma: PrismaClient, userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.email ?? userId;
}

export type ContentService = ReturnType<typeof createContentService>;
