// Model onboarding business logic: profile upsert, ToS + AI consent, and
// reference-image lifecycle (upload / list / delete). This layer owns the DB
// and object storage but knows nothing about HTTP, multipart, or cookies — the
// routes layer wires those.
//
// Storage keys are an internal detail and are NEVER returned to clients; only
// short-lived signed URLs, minted on demand, leave this layer.
import { randomUUID } from 'node:crypto';
import type { Currency } from '@creator-platform/shared';
import type {
  OnboardingProfileResponse,
  ReferenceImageItem,
} from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ProfileInput } from './onboarding.schema.js';

/** Hard cap on reference images per model, enforced server-side. */
export const MAX_REFERENCE_IMAGES = 10;
/** Signed-URL TTLs (seconds). Upload confirmation is shorter than profile view. */
const UPLOAD_URL_TTL = 60;
const PROFILE_URL_TTL = 300;

/** Typed error that carries the HTTP status the route should respond with. */
export class OnboardingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OnboardingError';
  }
}

export interface OnboardingServiceDeps {
  prisma: PrismaClient;
  storage: StorageClient;
  /** Bucket to read/write objects in (from STORAGE_BUCKET). */
  bucket: string;
}

export interface UpsertProfileResult {
  profileId: string;
  displayName: string;
  country: string;
  currency: Currency;
  aiConsent: boolean;
  tosAcceptedAt: string | null;
  /** True when a profile was created (201), false on update (200). */
  created: boolean;
}

export interface ReferenceImageUpload {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  /** File extension (no dot), derived from magic-byte detection. */
  ext: string;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function createOnboardingService({ prisma, storage, bucket }: OnboardingServiceDeps) {
  return {
    /** Create or update the authenticated model's profile (upsert by userId). */
    async upsertProfile(userId: string, input: ProfileInput): Promise<UpsertProfileResult> {
      const existing = await prisma.modelProfile.findUnique({ where: { userId } });

      // Stamp ToS acceptance the first time it's granted; never clear it once set.
      const tosAcceptedAt =
        input.tosAccepted && !existing?.tosAcceptedAt ? new Date() : existing?.tosAcceptedAt ?? null;

      const data = {
        displayName: input.displayName,
        bio: input.bio ?? null,
        country: input.country,
        currency: input.currency,
        tosAcceptedAt,
      };

      const profile = existing
        ? await prisma.modelProfile.update({ where: { userId }, data })
        : await prisma.modelProfile.create({ data: { ...data, userId } });

      return {
        profileId: profile.id,
        displayName: profile.displayName,
        country: profile.country,
        currency: profile.currency as Currency,
        aiConsent: profile.aiConsent,
        tosAcceptedAt: iso(profile.tosAcceptedAt),
        created: !existing,
      };
    },

    /**
     * Set AI likeness consent. Requires an existing profile (404) that has
     * already accepted the ToS (400) — consent is meaningless without it.
     */
    async setConsent(
      userId: string,
      aiConsent: boolean,
    ): Promise<{ aiConsent: boolean; aiConsentAt: string | null }> {
      const profile = await prisma.modelProfile.findUnique({ where: { userId } });
      if (!profile) {
        throw new OnboardingError(404, 'Profile not found');
      }
      if (!profile.tosAcceptedAt) {
        throw new OnboardingError(400, 'Terms of Service must be accepted before granting consent');
      }

      const updated = await prisma.modelProfile.update({
        where: { userId },
        data: { aiConsent, aiConsentAt: aiConsent ? new Date() : null },
      });

      return { aiConsent: updated.aiConsent, aiConsentAt: iso(updated.aiConsentAt) };
    },

    /**
     * Upload one reference image: enforce the per-model cap, push to storage,
     * persist the key, and return a short-lived signed URL for confirmation.
     */
    async addReferenceImage(
      userId: string,
      file: ReferenceImageUpload,
    ): Promise<ReferenceImageItem> {
      const profile = await prisma.modelProfile.findUnique({ where: { userId } });
      if (!profile) {
        throw new OnboardingError(404, 'Profile not found');
      }

      const count = await prisma.referenceImage.count({
        where: { modelProfileId: profile.id },
      });
      if (count >= MAX_REFERENCE_IMAGES) {
        throw new OnboardingError(400, `Reference image limit reached (max ${MAX_REFERENCE_IMAGES})`);
      }

      const key = `reference-images/${userId}/${randomUUID()}.${file.ext}`;
      await storage.uploadFile(bucket, key, file.buffer, file.mimeType);

      const record = await prisma.referenceImage.create({
        data: {
          modelProfileId: profile.id,
          storageKey: key,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        },
      });

      const signedUrl = await storage.getSignedUrl(bucket, key, UPLOAD_URL_TTL);
      return {
        imageId: record.id,
        signedUrl,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        createdAt: record.createdAt.toISOString(),
      };
    },

    /** Delete one of the authenticated model's reference images (403 if not theirs). */
    async deleteReferenceImage(userId: string, imageId: string): Promise<void> {
      const image = await prisma.referenceImage.findUnique({
        where: { id: imageId },
        include: { modelProfile: true },
      });
      if (!image) {
        throw new OnboardingError(404, 'Image not found');
      }
      if (image.modelProfile.userId !== userId) {
        throw new OnboardingError(403, 'Forbidden');
      }

      await storage.deleteFile(bucket, image.storageKey);
      await prisma.referenceImage.delete({ where: { id: imageId } });
    },

    /**
     * Full profile for the authenticated model, with a fresh signed URL per
     * reference image (never persisted). Single DB read (profile + images).
     */
    async getProfile(userId: string): Promise<OnboardingProfileResponse> {
      const profile = await prisma.modelProfile.findUnique({
        where: { userId },
        include: { referenceImages: { orderBy: { createdAt: 'asc' } } },
      });
      if (!profile) {
        throw new OnboardingError(404, 'Profile not found');
      }

      const referenceImages: ReferenceImageItem[] = await Promise.all(
        profile.referenceImages.map(async (img) => ({
          imageId: img.id,
          signedUrl: await storage.getSignedUrl(bucket, img.storageKey, PROFILE_URL_TTL),
          mimeType: img.mimeType,
          sizeBytes: img.sizeBytes,
          createdAt: img.createdAt.toISOString(),
        })),
      );

      return {
        profileId: profile.id,
        displayName: profile.displayName,
        bio: profile.bio ?? undefined,
        country: profile.country,
        currency: profile.currency as Currency,
        aiConsent: profile.aiConsent,
        aiConsentAt: iso(profile.aiConsentAt) ?? undefined,
        tosAcceptedAt: iso(profile.tosAcceptedAt) ?? undefined,
        referenceImages,
      };
    },
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
