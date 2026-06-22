/**
 * @creator-platform/shared
 *
 * Single source of truth for constants and types used by BOTH the web frontend
 * and the API backend. Keep this package framework-free (no React, no Fastify,
 * no Prisma) so either side can import it without pulling in runtime deps.
 */

// ─── Currencies ──────────────────────────────────────────────────────────────
/** Currencies the platform settles in. Must stay in sync with Stripe config. */
export const SUPPORTED_CURRENCIES = ['USD', 'BRL', 'EUR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

// ─── Locales ─────────────────────────────────────────────────────────────────
/** Base languages shipped at MVP; the app is i18n-ready for more. */
export const SUPPORTED_LOCALES = ['pt-BR', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'pt-BR';

// ─── Roles ───────────────────────────────────────────────────────────────────
/** Account roles used by RBAC. */
export const USER_ROLES = ['model', 'subscriber', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Canonical RBAC role type used across auth (Session 02). Mirrors `UserRole`;
 * these are the lowercase API/JWT representation. The Prisma `Role` enum is the
 * uppercase DB representation (ADMIN/MODEL/SUBSCRIBER) and is mapped at the
 * persistence boundary in the API.
 */
export type Role = UserRole;

/** Decoded JWT body for both access and refresh tokens. */
export interface JwtPayload {
  userId: string;
  role: Role;
}

/** Authenticated user shape surfaced by the API (never includes secrets). */
export interface AuthUser {
  userId: string;
  email: string;
  role: Role;
  displayName: string;
}

// ─── Onboarding (Session 03) ─────────────────────────────────────────────────
/** One uploaded reference image as surfaced by the API (signed URL is ephemeral). */
export type ReferenceImageItem = {
  imageId: string;
  signedUrl: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

/** Full model-onboarding profile returned by GET /api/onboarding/profile. */
export type OnboardingProfileResponse = {
  profileId: string;
  displayName: string;
  bio?: string;
  country: string;
  currency: Currency;
  aiConsent: boolean;
  aiConsentAt?: string;
  tosAcceptedAt?: string;
  referenceImages: ReferenceImageItem[];
};

// ─── Content (Session 04) ────────────────────────────────────────────────────
/** Media kinds the platform stores. Mirrors the Prisma `ContentType` enum. */
export const CONTENT_TYPES = ['IMAGE', 'VIDEO'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** Visibility tiers. Mirrors the Prisma `ContentTier` enum. */
export const CONTENT_TIERS = ['FREE', 'STANDARD', 'PREMIUM'] as const;
export type ContentTier = (typeof CONTENT_TIERS)[number];

/** Result of a successful upload (POST /api/content/upload). */
export type ContentUploadResponse = {
  contentId: string;
  title: string;
  tier: ContentTier;
  type: ContentType;
  isPublished: boolean;
};

/** One item in the model content listing (GET /api/content/model/:modelId). */
export type ContentListItem = {
  contentId: string;
  title: string;
  type: ContentType;
  tier: ContentTier;
  isPublished: boolean;
  /** Signed thumbnail URL (≤300s TTL); null when the requester lacks access. */
  thumbnailUrl: string | null;
  hasAccess: boolean;
  ppvPriceCents: number | null;
  viewCount: number;
  createdAt: string;
};

/** /serve response for videos (images stream raw watermarked bytes instead). */
export type ContentVideoServeResponse = {
  signedUrl: string;
  expiresIn: number;
};

// ─── App metadata ────────────────────────────────────────────────────────────
export const APP_NAME = 'Creator Platform';

// ─── Guards / helpers ────────────────────────────────────────────────────────
export function isCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
