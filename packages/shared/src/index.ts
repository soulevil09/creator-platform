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

/**
 * /serve response for videos (images stream raw watermarked bytes instead).
 *
 * `traceCode` (Session 09, Option B): the per-viewer forensic code the player
 * overlays on the `<video>`. The file behind `signedUrl` is NOT watermarked —
 * the overlay deters casual screen-recording only; a direct fetch of the URL
 * within its TTL yields the unmarked original. Documented residual risk.
 */
export type ContentVideoServeResponse = {
  signedUrl: string;
  expiresIn: number;
  traceCode: string;
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

/**
 * The reverse of `CHANNEL_CURRENCY`, derived from it rather than written out a
 * second time — a hand-maintained inverse is a table that can drift from the
 * one it mirrors. Used by the renewal sweep to reissue a charge on the same
 * rail the subscriber originally paid on: what a row records is the currency it
 * was billed in, not the channel (`provider` names an adapter, and a `mock`
 * adapter serving PIX reports `CCBILL_MOCK`, so it cannot answer this).
 * Returns undefined for a currency no channel bills in.
 */
export function channelForCurrency(currency: string): CheckoutChannel | undefined {
  return CHECKOUT_CHANNELS.find((channel) => CHANNEL_CURRENCY[channel] === currency);
}

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

// ─── Subscription lifecycle (Session 06.5) ───────────────────────────────────
/**
 * How many days before `currentPeriodEnd` the renewal charge is issued and the
 * reminder email sent. PIX and crypto are both one-shot instruments — there is
 * no stored mandate to pull from — so renewal is a fresh charge the subscriber
 * chooses to pay, and they need a few days' notice to do it.
 */
export const DEFAULT_SUBSCRIPTION_RENEWAL_REMINDER_DAYS = 3;

/**
 * How long after `currentPeriodEnd` a non-payer stays PAST_DUE before being
 * marked EXPIRED. Their access has already lapsed on its own by then
 * (`ContentAccess.expiresAt` is checked live at serve time); the grace window
 * is about how long the renewal charge they were sent stays worth paying.
 */
export const DEFAULT_SUBSCRIPTION_GRACE_PERIOD_DAYS = 3;

/** One row of GET /api/subscriptions/me — the caller's own subscriptions. */
export type SubscriptionListItem = {
  subscriptionId: string;
  modelId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  currentPeriodEnd: string;
  /**
   * True once the subscriber has opted out of renewal. They keep access until
   * `currentPeriodEnd`; no renewal charge is issued; then the row goes
   * CANCELED rather than PAST_DUE.
   */
  cancelAtPeriodEnd: boolean;
};

/** GET /api/subscriptions/me. */
export type MySubscriptionsResponse = {
  subscriptions: SubscriptionListItem[];
};

/**
 * POST /api/subscriptions/renewals/run — aggregate only, for the same reason
 * the payout run's summary is: the caller is a cron job holding a shared
 * secret, so the response must not double as a subscriber-history oracle.
 */
export type SubscriptionRenewalRunSummary = {
  remindersIssued: number;
  movedToPastDue: number;
  movedToExpired: number;
  movedToCanceled: number;
};

// ─── Anti-leak & content protection (Session 09) ─────────────────────────────
/**
 * POST /api/admin/storage/cleanup/run — aggregate only, same reasoning as the
 * payout and renewal run summaries: the caller is a cron job holding a shared
 * secret, and the body lands in a CI step summary. Never a storage key.
 */
export type StorageCleanupRunSummary = {
  /** Objects deleted and their rows' `storageKey` nulled. */
  deleted: number;
  /** Rows another run claimed first (or already keyless when read). */
  skipped: number;
  /** Deletes the storage provider rejected; the key stays for the next run. */
  failed: number;
};

// ─── Messaging (Session 07) ──────────────────────────────────────────────────
/**
 * Media kinds a chat message may carry. Mirrors the Prisma
 * `MessageAttachmentType` enum, and deliberately not `CONTENT_TYPES`: chat
 * attachments and the monetized content library are different products with
 * different size caps, so widening one must not silently widen the other.
 */
export const MESSAGE_ATTACHMENT_TYPES = ['IMAGE', 'VIDEO'] as const;
export type MessageAttachmentType = (typeof MESSAGE_ATTACHMENT_TYPES)[number];

/** Max characters in a message body — enforced server-side by Zod. */
export const MESSAGE_BODY_MAX_LENGTH = 4000;

/** Default / maximum page size for the cursor-paginated history read. */
export const MESSAGE_PAGE_SIZE_DEFAULT = 50;
export const MESSAGE_PAGE_SIZE_MAX = 100;

/** Characters of the last message shown as a conversation-list preview. */
export const MESSAGE_PREVIEW_MAX_LENGTH = 120;

/**
 * One message as surfaced by the API and pushed over the socket.
 *
 * There is no attachment URL and no storage key here by design: the key never
 * leaves the server (same rule as `Content.storageKey`), and a URL embedded in
 * history would outlive the 60-second TTL it was minted with. A client that
 * wants the bytes calls GET /api/messages/attachments/:messageId with the
 * `messageId` below and gets a fresh signed URL.
 */
export type MessageItem = {
  messageId: string;
  conversationId: string;
  senderId: string;
  /** Null when the message is attachment-only. */
  body: string | null;
  attachmentType: MessageAttachmentType | null;
  attachmentMimeType: string | null;
  attachmentSizeBytes: number | null;
  /** Null while the other participant has not opened the conversation. */
  readAt: string | null;
  createdAt: string;
};

/** POST /api/messages/conversations/:modelId — 201 created, 200 existing. */
export type ConversationSummary = {
  conversationId: string;
  subscriberId: string;
  modelId: string;
  lastMessageAt: string | null;
  createdAt: string;
};

/** One row of GET /api/messages/conversations. */
export type ConversationListItem = {
  conversationId: string;
  /** The participant who is not the caller. */
  otherParticipantId: string;
  otherParticipantDisplayName: string;
  /**
   * The newest message, truncated — or `"[image]"` / `"[video]"` when that
   * message carried only an attachment. Null for a conversation with no
   * messages yet.
   */
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  /** Unread messages sent by the *other* participant. */
  unreadCount: number;
};

/** GET /api/messages/conversations. */
export type ConversationListResponse = {
  conversations: ConversationListItem[];
};

/**
 * GET /api/messages/conversations/:conversationId/messages — newest first.
 * `nextCursor` is the id to pass back as `?before=`, or null at the end of the
 * history. Cursor-based, never offset-based: offsets shift under inserts, and
 * a chat is append-heavy by definition.
 */
export type MessageHistoryResponse = {
  messages: MessageItem[];
  nextCursor: string | null;
};

/**
 * POST /api/messages/conversations/:conversationId/messages, JSON form. An
 * attachment is sent as multipart instead, with the same optional `text` as a
 * form field.
 */
export type SendMessageRequest = {
  text?: string;
};

/** 201 body of a successful send. */
export type SendMessageResponse = MessageItem;

/** GET /api/messages/attachments/:messageId — short-lived, never the key. */
export type MessageAttachmentUrlResponse = {
  signedUrl: string;
  expiresIn: number;
};

/** PATCH /api/messages/conversations/:conversationId/read. */
export type MarkConversationReadResponse = {
  conversationId: string;
  /** How many messages this call actually flipped to read (0 on a re-run). */
  markedRead: number;
};

/**
 * The only event the socket carries. The WebSocket is broadcast-only — every
 * message is written through the REST send endpoint, so there is exactly one
 * audited, rate-limited write path and the socket stays a pure read-side
 * concern (the same "one call site" discipline as `issueSubscriptionCharge`).
 */
export const MESSAGE_EVENT_NEW = 'message.new';

export type MessageNewEvent = {
  type: typeof MESSAGE_EVENT_NEW;
  message: MessageItem;
};

/** Every event pushed over /ws/messages. A union of one, for now. */
export type MessagingSocketEvent = MessageNewEvent;

// ─── AI generation (Session 08) ──────────────────────────────────────────────
/**
 * How a subscriber describes the image they want. `preset` picks an entry
 * from `GENERATION_PRESETS`; `custom` is free text that goes through the
 * content-safety gate. Lowercase wire form; the Prisma `GenerationMode` enum is
 * the uppercase DB form, mapped at the persistence boundary (same convention
 * as roles).
 */
export const GENERATION_MODES = ['preset', 'custom'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

/** Lifecycle of one `GenerationJob`. Mirrors the Prisma `GenerationStatus` enum. */
export const GENERATION_STATUSES = ['PENDING', 'COMPLETED', 'FAILED'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/**
 * One preset a subscriber can pick. Server-side catalog: the client sends an
 * `id`, and the cost is always resolved from this table — a client-supplied
 * cost, if sent, is ignored (same rule as `SUBSCRIPTION_PLANS` / `CREDIT_PACKS`).
 * The prompt text behind each preset lives in the API only; it is not part of
 * the catalog a browser downloads.
 */
export type GenerationPreset = {
  id: string;
  label: string;
  creditsCost: number;
};

// `as const satisfies` keeps the ids as literal types (so the API's per-preset
// prompt table can be keyed by them and typecheck fails when the two drift)
// while still checking every entry against `GenerationPreset`.
export const GENERATION_PRESETS = [
  { id: 'hair_long_blonde', label: 'Long blonde hair', creditsCost: 10 },
  { id: 'hair_short_dark', label: 'Short dark hair', creditsCost: 10 },
  { id: 'outfit_red_dress', label: 'Red evening dress', creditsCost: 10 },
  { id: 'outfit_black_lingerie', label: 'Black lingerie', creditsCost: 10 },
  { id: 'pose_mirror_selfie', label: 'Mirror selfie', creditsCost: 10 },
  { id: 'pose_lying_on_bed', label: 'Lying on a bed', creditsCost: 10 },
  { id: 'scene_beach_sunset', label: 'Beach at sunset', creditsCost: 10 },
  { id: 'scene_neon_city', label: 'Neon city at night', creditsCost: 10 },
] as const satisfies readonly GenerationPreset[];

export function findGenerationPreset(presetId: string): GenerationPreset | undefined {
  return GENERATION_PRESETS.find((preset) => preset.id === presetId);
}

/**
 * Credits one custom-prompt generation costs. Higher than a preset: free text
 * costs the platform the safety gate plus a less predictable provider run.
 */
export const GENERATION_CUSTOM_PROMPT_COST = 25;

/** POST /api/generations — a discriminated union on `mode`; no cost field exists. */
export type CreateGenerationRequest =
  | { modelId: string; mode: 'preset'; presetId: string }
  | { modelId: string; mode: 'custom'; customPrompt: string };

/**
 * One job as surfaced by the gallery list. `imageUrl` is a short-lived signed
 * URL, present only while the job is COMPLETED and unexpired; there is no
 * storage key here by design (same rule as `Content.storageKey`).
 */
export type GenerationListItem = {
  generationId: string;
  modelId: string;
  mode: GenerationMode;
  presetId: string | null;
  status: GenerationStatus;
  creditsCost: number;
  imageUrl: string | null;
  /** Null until COMPLETED; past it the image is no longer servable. */
  expiresAt: string | null;
  createdAt: string;
};

/** GET /api/generations — newest first; `nextCursor` feeds back as `?before=`. */
export type GenerationListResponse = {
  generations: GenerationListItem[];
  nextCursor: string | null;
};

/**
 * GET /api/generations/:id. Adds the subscriber's own prompt text (or the
 * preset label) — never the hidden anchor prompt, which is not stored at all.
 */
export type GenerationDetailResponse = GenerationListItem & {
  userPrompt: string | null;
};

/** 201 body of POST /api/generations — the completed job. */
export type CreateGenerationResponse = GenerationDetailResponse;

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
