/**
 * @creator-platform/shared
 *
 * Single source of truth for constants and types used by BOTH the web frontend
 * and the API backend. Keep this package framework-free (no React, no Fastify,
 * no Prisma) so either side can import it without pulling in runtime deps.
 */

// ─── Currencies ──────────────────────────────────────────────────────────────
/**
 * Currencies the platform settles in. PIX charges are always BRL; crypto
 * charges are priced in USD and settled in the coin the payer picks.
 */
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
  viewCount: number;
  createdAt: string;
};

/** /serve response for videos (images stream raw watermarked bytes instead). */
export type ContentVideoServeResponse = {
  signedUrl: string;
  expiresIn: number;
};

// ─── Payments (Session 05) ───────────────────────────────────────────────────
/**
 * Payment channels. Each is served by one adapter implementing
 * `IPaymentProvider`, selected at startup from `PAYMENT_PROVIDER_<CHANNEL>`.
 * `card` is scaffolded but mocked until CCBill is activated post-MVP.
 */
export const PAYMENT_CHANNELS = ['pix', 'crypto', 'card'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

/** Channels a client may choose at checkout (card is not sellable at MVP). */
export const CHECKOUT_CHANNELS = ['pix', 'crypto'] as const;
export type CheckoutChannel = (typeof CHECKOUT_CHANNELS)[number];

/** Provider identities as persisted on every payment row. */
export const PAYMENT_PROVIDERS = ['WOOVI', 'NOWPAYMENTS', 'CCBILL_MOCK'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_TRANSACTION_TYPES = ['SUBSCRIPTION', 'CREDIT_PACK'] as const;
export type PaymentTransactionType = (typeof PAYMENT_TRANSACTION_TYPES)[number];

export const PAYMENT_STATUSES = ['PENDING', 'CONFIRMED', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'CANCELED', 'PAST_DUE', 'EXPIRED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Sellable subscription tiers — FREE is a public teaser and is never sold. */
export const SUBSCRIPTION_TIERS = ['STANDARD', 'PREMIUM'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

/** Days of access one subscription payment buys. */
export const SUBSCRIPTION_PERIOD_DAYS = 30;

/**
 * Catalog prices, in **minor units** (centavos / cents) so no float ever
 * touches money. The channel picks the currency: PIX bills BRL, crypto bills
 * USD. Server-side only — a client never sends an amount.
 */
export type CatalogPrice = { BRL: number; USD: number };

export const SUBSCRIPTION_PLANS: Record<
  SubscriptionTier,
  { tier: SubscriptionTier; label: string; price: CatalogPrice }
> = {
  STANDARD: { tier: 'STANDARD', label: 'Standard', price: { BRL: 2990, USD: 599 } },
  PREMIUM: { tier: 'PREMIUM', label: 'Premium', price: { BRL: 5990, USD: 1199 } },
};

/** Credit packs a subscriber can buy. `credits` is the internal currency. */
export type CreditPack = {
  id: string;
  label: string;
  credits: number;
  price: CatalogPrice;
};

export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: 'starter', label: 'Starter', credits: 100, price: { BRL: 1990, USD: 399 } },
  { id: 'plus', label: 'Plus', credits: 300, price: { BRL: 4990, USD: 999 } },
  { id: 'pro', label: 'Pro', credits: 1000, price: { BRL: 14990, USD: 2999 } },
] as const;

export function findCreditPack(packId: string): CreditPack | undefined {
  return CREDIT_PACKS.find((pack) => pack.id === packId);
}

/** Currency each checkout channel bills in. */
export const CHANNEL_CURRENCY: Record<CheckoutChannel, Extract<Currency, 'BRL' | 'USD'>> = {
  pix: 'BRL',
  crypto: 'USD',
};

// ─── Checkout responses ──────────────────────────────────────────────────────
/** PIX presentation payload: a QR image plus the "copia e cola" BR code. */
export type PixChargePayload = {
  method: 'pix';
  /** Data/HTTPS URL of the QR code image rendered by the provider. */
  qrCodeImage: string;
  /** EMV "copia e cola" string the payer pastes into their bank app. */
  brCode: string;
  /** Hosted payment page, when the provider supplies one. */
  paymentLinkUrl: string | null;
};

/** Crypto presentation payload: where to send how much of which coin. */
export type CryptoChargePayload = {
  method: 'crypto';
  payAddress: string;
  /** Decimal string — crypto amounts are not integers and never floats. */
  payAmount: string;
  payCurrency: string;
  /** Some networks require a memo/tag (XRP, XLM, …). */
  payMemo: string | null;
};

/** Deterministic stand-in used by the deferred card channel. */
export type MockChargePayload = {
  method: 'mock';
  checkoutUrl: string;
};

export type ChargePayload = PixChargePayload | CryptoChargePayload | MockChargePayload;

/** 201 body returned by both checkout endpoints. */
export type CheckoutResponse = {
  transactionId: string;
  provider: PaymentProviderName;
  /** Local correlation id echoed back by the provider webhook. */
  idempotencyKey: string;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  expiresAt: string | null;
  payment: ChargePayload;
};

/** GET /api/wallet/balance — the caller's own balance, never anyone else's. */
export type WalletBalanceResponse = {
  userId: string;
  balance: number;
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

// ─── Payouts (Session 06) ────────────────────────────────────────────────────
/**
 * Payout adapter identities, as persisted on every `Payout` row. `PAXUM_MOCK`
 * is the deterministic offline stand-in (`PAYOUT_PROVIDER=mock`), mirroring
 * the role `CCBILL_MOCK` plays on the payments side.
 */
export const PAYOUT_PROVIDERS = ['PAXUM', 'PAXUM_MOCK'] as const;
export type PayoutProviderName = (typeof PAYOUT_PROVIDERS)[number];

/**
 * Lifecycle of one `Payout` row.
 *
 *   PENDING     — created and funded locally; not yet handed to the provider
 *   PROCESSING  — the provider accepted the batch; awaiting its IPN
 *   COMPLETED   — the provider confirmed the money landed
 *   FAILED      — the provider rejected it; the included transactions were
 *                 released back to the unpaid pool for the next run
 *
 * Distinct from `PayoutStatus` in `modules/payouts/provider.interface.ts`,
 * which is the *provider's* three-state vocabulary (PENDING|PAID|FAILED)
 * normalized out of an adapter. This one is our own record's state.
 */
export const PAYOUT_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type PayoutRecordStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * Model's cut of a confirmed subscription payment, as a whole percent.
 * 80/20 matches the OnlyFans/Fansly/Fanvue industry standard. Overridable per
 * deployment via `REVENUE_SHARE_MODEL_PCT`.
 */
export const DEFAULT_REVENUE_SHARE_MODEL_PCT = 80;

/**
 * Minimum unpaid balance (minor units) a model must reach to be paid in a run.
 * R$50. Below it the balance simply stays unclaimed and rolls into next week —
 * that falls out of the balance query, so there is no carry-over bookkeeping.
 */
export const DEFAULT_PAYOUT_MIN_THRESHOLD_CENTS = 5000;

/** Days one payout run covers. Weekly cadence, Monday 12:00 UTC. */
export const PAYOUT_PERIOD_DAYS = 7;

/** GET /api/payouts/balance — the caller's own balance, never anyone else's. */
export type PayoutBalanceResponse = {
  modelId: string;
  /** SUM(modelShareCents) over confirmed, not-yet-paid subscription earnings. */
  availableCents: number;
  currency: Currency;
  thresholdCents: number;
  /** True when `availableCents` would be picked up by the next run. */
  eligible: boolean;
  /**
   * Whether the model has set the Paxum address their earnings are sent to.
   * False means a payout run will skip them however large the balance — the
   * UI should prompt for it before they expect to be paid.
   */
  payoutEmailConfigured: boolean;
};

/** PUT /api/payouts/payout-email — confirmation of the new destination. */
export type PayoutEmailResponse = {
  modelId: string;
  payoutEmail: string;
  updatedAt: string;
};

/**
 * POST /api/payouts/run — aggregate only. Deliberately carries no per-model
 * identifiers or amounts: the caller is a cron job, not an authenticated
 * admin, so the response must not become a payout-history oracle.
 */
export type PayoutRunSummary = {
  processed: number;
  skipped: number;
  failed: number;
  totalCents: number;
};

/** One row in an admin payout listing. */
export type PayoutListItem = {
  payoutId: string;
  modelId: string;
  amountCents: number;
  currency: Currency;
  status: PayoutRecordStatus;
  provider: PayoutProviderName;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
};

/** GET /api/payouts — ADMIN-only paginated listing. */
export type PayoutListResponse = {
  payouts: PayoutListItem[];
  total: number;
  limit: number;
  offset: number;
};

/** GET /api/payouts/:payoutId — ADMIN or the owning MODEL. */
export type PayoutDetailResponse = PayoutListItem & {
  /** How many PaymentTransaction rows this payout settled. */
  transactionCount: number;
};
