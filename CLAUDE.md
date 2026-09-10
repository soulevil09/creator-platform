# CLAUDE.md — Creator Platform

## Project Overview
A content monetization platform (OnlyFans-style) with AI-powered image personalization for subscribers.
Models authorize use of their likeness for AI-generated personalized images. Subscribers pay for preset
options or custom prompts. A hidden system prompt anchors the model's likeness behind every AI request.

**GitHub:** https://github.com/soulevil09/creator-platform  
**Content category:** Adult (18+) — payment stack chosen accordingly (Stripe is permanently excluded)  
**Supported currencies:** USD, BRL, EUR  
**Base languages:** PT-BR, EN (i18n-ready)  
**Budget philosophy:** Start lean with free-tier/serverless tools. Architecture must support swapping to
more robust/expensive services as revenue scales.

---

## Tech Stack

| Layer | Choice | Justification |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Fast, disk-efficient, strict symlinked workspaces; Turborepo caches build/lint/test. Free, no lock-in. |
| Frontend | Next.js 14 (App Router) | TypeScript-first React, SSR/ISR, file routing, serverless-friendly deploy, i18n-ready. |
| Backend | Fastify 5 | Lean, fast, low-overhead. Upgraded from v4 to v5 in Session 02 to align with plugin majors. |
| ORM / DB | Prisma + PostgreSQL (Supabase) | Type-safe client, migrations, swappable provider. Supabase = managed free Postgres, no card. |
| Auth | JWT (access 15m + refresh 7d) — httpOnly cookies, RBAC | Stateless, framework-agnostic, refresh-token rotation. Implemented in Session 02. |
| Storage | Supabase Storage (S3-compatible) | Finalized Session 03. Accessed via `@aws-sdk/client-s3` so the same code works against Cloudflare R2 / AWS S3 if swapped. Signed URLs via the presigner (local HMAC). |
| Email | Resend | Free tier, simple API for transactional email. Active from Session 02. |
| AI Images | Replicate (SDXL) — _Session 08_ | Pay-per-use, no subscription, hosted SDXL; swappable behind an `AI_PROVIDER` abstraction. |
| Payments (PIX/BR) | **Woovi (OpenPix)** | Brazilian fintech, CNPJ-backed, PCI DSS compliant. PIX nativo com liquidação imediata. Plano percentual: 0,80% por transação (mín R$0,50 / máx R$5,00). Zero setup/monthly fee. API REST documentada, webhooks em tempo real, SDK Node.js oficial. Conta PJ criada com MEI CNPJ 67.735.318/0001-91, chave PIX CNPJ vinculada ao Nubank PJ. |
| Payments (crypto) | **NOWPayments** | 0.5% per transaction, zero setup/monthly fee. 350+ cryptocurrencies + stablecoins (USDT, USDC). Native subscription/recurring billing API. Adult content explicitly permitted by ToS. Forbes Advisor #1 crypto gateway 2025. Non-custodial option available. |
| Payments (card — deferred) | _(CCBill — locked, post-MVP)_ | CCBill is the confirmed future card processor for international Visa/Mastercard. Requires Visa ($950/yr) + Mastercard ($500/yr) high-risk registration fees — deferred until platform generates enough revenue to absorb. Architecture is abstraction-ready on day one. |
| Model payouts | **Paxum** mass payout REST API | Industry-standard for adult creator payouts. Implemented Session 06 as `PaxumAdapter implements IPayoutProvider`, selected via `PAYOUT_PROVIDER`. Weekly run triggered by a GitHub Actions cron job hitting `POST /api/payouts/run` behind a timing-safe service secret. 80/20 split (model/platform), R$50 minimum threshold. Wire format is provisional until the Business account is approved — see Open Items. |
| Lint / Format | ESLint 9 (flat) + Prettier | One root config governs all packages; modern TS standard. |
| Tests | Vitest | ESM/TS-native, Jest-compatible, fast. In-memory mocks for DB + email in auth tests. |
| CI | GitHub Actions | Free tier, native GitHub integration. |

> ⚠️ **Stripe is permanently excluded** from this project. Stripe explicitly prohibits adult content, AI-generated adult images, and credit-based adult platforms. Any suggestion to use Stripe must be rejected.

> ⚠️ **All Brazilian-based processors (PagBank, Pagar.me, Mercado Pago, Transfeera, OrendaPay, SyncPay, Kirvano) are incompatible** with adult content under Banco Central do Brasil and Visa/Mastercard network policies. Never suggest them.

> 📋 **CCBill is the locked future card processor** — do not replace it with anything else when cards are activated. The $1,450/yr Visa+MC registration fee is a Visa/Mastercard network requirement, not CCBill-specific — it applies to any adult card processor.

---

## Revenue Model

| Flow | Method | Notes |
|---|---|---|
| Subscriber pays monthly subscription | Woovi PIX (BR) or Crypto (NOWPayments) | Grants access to model's content tier |
| Subscriber buys credit pack | Woovi PIX (BR) or Crypto (NOWPayments) | Credits deposited to subscriber wallet |
| Subscriber spends credits | Internal debit (no new payment) | Triggers AI image generation |
| Platform pays model | Paxum API (weekly) | 80% model / 20% platform, split stamped on each confirmed SUBSCRIPTION transaction; paid Mondays 12:00 UTC above a R$50 threshold |
| _(Future)_ Subscriber pays via card | CCBill (post-MVP) | Activates when Visa/MC registration fees are sustainable |

---

## Payment Provider Abstraction

All payment business logic is decoupled from provider-specific implementations via shared interfaces.
**Every payment channel — PIX, crypto, and future card — must implement these interfaces.**
Swapping any provider = swap the adapter only. Business logic never touches provider internals.

```
IPaymentProvider
  ├── createSubscription(plan, user) → SubscriptionResult
  ├── createCreditPurchase(pack, user) → ChargeResult
  ├── cancelSubscription(subscriptionId) → void
  └── handleWebhook(payload, signature) → PaymentEvent

WooviPixAdapter      implements IPaymentProvider  ← PIX (BR market, via Woovi/OpenPix)
NOWPaymentsAdapter   implements IPaymentProvider  ← Crypto (global, via NOWPayments)
CCBillAdapter        implements IPaymentProvider  ← Card (deferred/mocked at MVP; activates post-MVP)

IPayoutProvider
  ├── createPayout(params) → PayoutResult
  ├── verifyWebhookSignature(rawBody, headers) → boolean
  └── parseWebhookEvent(rawBody) → NormalizedPayoutEvent

PaxumAdapter         implements IPayoutProvider   ← model earnings distribution
MockPayoutProvider   implements IPayoutProvider   ← tests + PAYOUT_PROVIDER=mock

MockPaymentProvider  implements IPaymentProvider  ← used in tests and for the deferred CCBill slot
```

Active providers at MVP:
- `PAYMENT_PROVIDER_PIX=woovi` → `WooviPixAdapter`
- `PAYMENT_PROVIDER_CRYPTO=nowpayments` → `NOWPaymentsAdapter`
- `PAYMENT_PROVIDER_CARD=mock` → `MockPaymentProvider` (slot reserved for CCBill)

The provider is selected at startup via env var and injected via the container. Business logic
(credit wallet, subscription grants, revenue share) calls only the interface — never the adapter.

---

## Session Map

### Session 01 — Bootstrap ✅ Complete
**File:** `.claude/sessions/session-01.md`  
**Domain:** Monorepo structure, TypeScript config, CI skeleton, env setup, README, Prisma init

**Summary:**
- pnpm workspaces + Turborepo scaffold
- Next.js 14 App Router (`apps/web`), Fastify (`apps/api`), shared package
- Prisma initialized with Supabase datasource (no models yet)
- ESLint 9 flat + Prettier, Vitest, GitHub Actions CI
- All typecheck/lint/test jobs green

---

### Session 02 — Auth ✅ Complete
**File:** `.claude/sessions/session-02.md`  
**Domain:** Registration (model/subscriber roles), login, JWT + refresh tokens, RBAC middleware

**Summary:**
- `User` model + `Role` enum (ADMIN/MODEL/SUBSCRIBER) added to Prisma schema
- Migration `20260619034002_add_user_model` applied to Supabase; unique indexes on `email` and `verifyToken`
- POST /api/auth/register — bcrypt cost 12, 32-byte hex email verify token (24h TTL), Resend email, rate-limited 5/IP/h
- GET /api/auth/verify-email — one-time token consumption with expiry check
- POST /api/auth/login — bcrypt compare, 403 unverified, JWT in httpOnly/SameSite=Strict cookies, rate-limited 10/IP/15min, no tokens in body
- POST /api/auth/refresh — token rotation, old hash invalidated; SHA-256 pre-digest before bcrypt to bypass 72-byte truncation
- POST /api/auth/logout — cookies cleared (maxAge=0), `refreshTokenHash` nulled in DB
- GET /api/auth/me — authenticated, returns `{ userId, email, role, displayName, isVerified }`
- `authenticate` + `authorize(...roles)` RBAC hooks in `src/middleware/auth.ts`
- Shared types: `Role`, `JwtPayload`, `AuthUser` added to `@creator-platform/shared`
- `src/lib/env.ts` — startup crash if `JWT_SECRET`, `JWT_REFRESH_SECRET`, or `EMAIL_API_KEY` missing
- 17/17 tests passing; `pnpm turbo run typecheck test lint` all green

**Security fixes found during session:**
- Fastify upgraded 4→5 (plugin majors @fastify/jwt@10, @fastify/cookie@11, @fastify/rate-limit@11 require Fastify 5 — would throw at registration on v4)
- bcrypt 72-byte truncation: refresh token is SHA-256 digested before bcrypt hash so the full token (including signature) is protected

---

### Session 03 — Model Onboarding ✅ Complete
**File:** `.claude/sessions/session-03.md`  
**Domain:** Model profile data, reference image upload, AI consent/ToS flow

**Summary:**
- `ModelProfile` (1:1 with MODEL `User`) + `ReferenceImage` models added to Prisma; migration `20260620163515_add_model_profile` applied to Supabase
- `apps/api/src/lib/storage.ts` — S3-compatible `StorageClient` (`uploadFile`/`getSignedUrl`/`deleteFile`) via `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`; provider-agnostic behind `STORAGE_*` env
- `STORAGE_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY` added to `src/lib/env.ts` eager validation (+ `STORAGE_REGION` tunable); stubbed in `vitest.setup.ts`
- Onboarding module (`src/modules/onboarding/`), all MODEL-only (`authenticate` + `authorize('model')`):
  - `PUT /api/onboarding/profile` — upsert by userId, 201 create / 200 update, ToS stamping, 10/min
  - `POST /api/onboarding/consent` — requires profile (404) + ToS accepted (400), sets `aiConsent`/`aiConsentAt`, 5/min
  - `POST /api/onboarding/reference-images` — multipart, magic-byte + Content-Type match validation (`file-type`), 10 MB cap, max 10/model, 20/hour
  - `DELETE /api/onboarding/reference-images/:imageId` — ownership-checked (403), 204
  - `GET /api/onboarding/profile` — full profile + on-demand signed URLs (300s TTL), 404 if absent
- `@fastify/multipart` registered globally (`attachFieldsToBody:false`, `throwFileSizeLimit:false`, 10 MB / 1 file)
- Shared types `OnboardingProfileResponse` + `ReferenceImageItem` exported from `@creator-platform/shared`
- Storage keys never leave the service — only short-TTL signed URLs; signed URLs never persisted
- 21 new tests (38 total); `pnpm turbo run typecheck lint test` all green

**Notes / deviations:**
- Spec wrote `authorize('MODEL')`; the codebase RBAC role type is lowercase (`'model'`), mapped to the uppercase Prisma enum at the persistence boundary — used `authorize('model')` to match Session 02.
- Storage keys generated with `crypto.randomUUID()` (no extra cuid dep): `reference-images/{userId}/{uuid}.{ext}`.
- "ARIA validation" in the spec DoD is N/A — this session ships no frontend UI.

**External Prerequisites (done):**
- [x] Object storage configured: Supabase Storage S3 endpoint + access/secret keys in `apps/api/.env`

---

### Session 04 — Content Management ✅ Complete
**File:** `.claude/sessions/session-04.md`  
**Domain:** Upload pipeline, signed URL serving, watermarking, tier-based access control

**Summary:**
- `Content` + `ContentAccess` models, `ContentType`/`ContentTier` enums, and `Content.deletedAt` soft-delete field added to Prisma; `User` gains `uploadedContent` / `contentAccesses` relations. Migration `20260621153750_add_content_management` applied to Supabase; client regenerated.
- `StorageClient.getObject(bucket, key)` added — streams an S3 object to a Buffer (used by `/serve` for on-the-fly watermarking). Never re-uploaded/cached.
- `apps/api/src/lib/image.ts` — injectable `ImageProcessor` (sharp-backed `createSharpImageProcessor`): `getDimensions` + `watermark` (SVG overlay, bottom-right, white @40% opacity + dark drop shadow, longest edge capped at 2048px). Wired into `buildServer` like storage/emailer so tests inject a fake and never load sharp's native binary.
- Content module (`src/modules/content/`):
  - `POST /api/content/upload` — MODEL-only, multipart, magic-byte + Content-Type match + declared-type cross-check (`file-type`), per-type caps (50 MB image / 500 MB video → 413), sharp dimensions for images, verified-model + profile gate (403), `content/{modelId}/{cuid2}.{ext}` key, 201, 20/model/hour. Per-call multipart `fileSize` override (500 MB) supersedes the global 10 MB cap.
  - `PATCH /api/content/:contentId/publish` — MODEL-only, ownership-checked (403), toggles `isPublished`, 200.
  - `GET /api/content/model/:modelId` — optional auth; FREE always listed, STANDARD/PREMIUM only when accessible (owner/admin/active grant); thumbnails are parallel signed URLs (300s TTL); `storageKey` never serialized.
  - `GET /api/content/:contentId/serve` — `authenticate` required; access check (owner/admin/FREE/valid non-expired `ContentAccess`, PREMIUM needs a `subscription_premium` grant) else 403; images streamed watermarked with `Cache-Control: no-store`; videos return a 60s signed URL; `viewCount` bumped fire-and-forget.
  - `DELETE /api/content/:contentId` — MODEL or ADMIN; soft-delete (`deletedAt` + unpublish); 204; storage object left for a future cleanup job.
  - `grantContentAccess` / `revokeContentAccess` service functions (upsert/deleteMany on `contentId+userId`) — used by `/serve` (owner audit) now, by Session 05's payment webhooks later.
- Shared types `ContentType`, `ContentTier`, `ContentUploadResponse`, `ContentListItem`, `ContentVideoServeResponse` + `CONTENT_TYPES`/`CONTENT_TIERS` exported from `@creator-platform/shared`.
- 15 new tests (53 total); `pnpm turbo run typecheck lint test` all green, zero regressions.

**Notes / deviations:**
- `/serve` allows FREE content to any authenticated user (FREE = public teaser), in addition to the spec's owner/admin/`ContentAccess` checks.
- List endpoint returns gated tiers **only when accessible**, so `thumbnailUrl` is null only defensively (locked-teaser listing — showing inaccessible items with null thumbnails — is deferred). Anonymous requesters see FREE only.
- Video duration/watermarking out of scope (no ffmpeg/ffprobe) — `durationSecs` stays null, video served via signed URL.
- "ARIA validation" in the DoD is N/A — this session ships no frontend UI (same as Session 03).

**External Prerequisites (done):**
- [x] Storage bucket from Session 03 configured (Supabase Storage finalized as the provider)

---

### Session 05 — Payments ✅ Complete
**File:** `.claude/sessions/session-05.md`  
**Domain:** Woovi PIX (subscriptions + credit packs), NOWPayments crypto (subscriptions + credit packs), provider-swappable IPaymentProvider + IPayoutProvider abstractions, webhook handling, credit wallet, mocked CCBill slot

**Summary:**
- `Subscription`, `CreditWallet`, `PaymentTransaction`, `AuditLog` models + `PaymentProvider` / `PaymentTransactionType` / `PaymentStatus` / `SubscriptionStatus` enums added to Prisma; `User` gains `creditWallet` / `paymentTransactions` / `subscriptions` / `subscribers` / `auditLogs` relations. Migration `20260830120000_add_payments` generated (UNIQUE on `PaymentTransaction.idempotencyKey`, UNIQUE on `(subscriberId, modelId)`, `CHECK (balance >= 0)` on `CreditWallet`) — **generated offline, not yet applied** (see Open Items).
- `IPaymentProvider` (`src/modules/payments/provider.interface.ts`) — `createCharge` / `verifyWebhookSignature` / `parseWebhookEvent`. Signature verification is synchronous and total (returns `false`, never throws) so a forged callback is rejected before any DB access.
- `provider.factory.ts` — `getPaymentProvider(channel)` reads `PAYMENT_PROVIDER_PIX/_CRYPTO/_CARD` from `process.env`, memoises per channel, and throws `PaymentProviderConfigError` on an unknown name. `assertPaymentProvidersConfigured()` runs in `buildServer` so a typo crashes at boot. `mock` is additionally valid for pix/crypto as an offline dev setting; **card accepts `mock` only**.
- `WooviPixAdapter` — `POST /api/v1/subscriptions` (recurrence, subscriptions only) + `POST /api/v1/charge` (period 1 / one-off), App ID in the `Authorization` header, BRL-only guard. Webhook signature = base64 HMAC-SHA256 over the raw body, constant-time compared.
- `NOWPaymentsAdapter` — `POST /v1/payment` (fiat-priced, crypto-settled) + optional `POST /v1/subscriptions` when `NOWPAYMENTS_PLAN_ID_<TIER>` is configured. IPN signature = hex HMAC-SHA512 over **alphabetically sorted-key** JSON (the provider's documented scheme).
- `MockPaymentProvider` — deterministic, zero HTTP, channel-configurable; serves the deferred CCBill card slot.
- `POST /api/payments/checkout/subscription` and `/checkout/credits` — subscriber-only (`authenticate` + `authorize('subscriber')`), 10 req/min keyed on **userId** (not IP), price resolved from the `SUBSCRIPTION_PLANS` / `CREDIT_PACKS` catalog in `@creator-platform/shared` (a client-supplied amount is ignored), `PENDING` `PaymentTransaction` written before the provider call, provider failure → row marked `FAILED` + audited + 502.
- `POST /api/payments/woovi/webhook` and `/nowpayments/webhook` — a plugin-scoped JSON content-type parser keeps `request.rawBody` so signatures hash exactly what the provider signed. Verify → 400 on mismatch with zero DB access; confirm via a conditional `updateMany({ where: { idempotencyKey, status: 'PENDING' } })` inside one `$transaction` that also credits the wallet (CREDIT_PACK) or upserts the `Subscription` + grants `ContentAccess` (SUBSCRIPTION) and writes the `AuditLog`. Duplicates and unknown correlation ids answer 200 with no side effects (a retry cannot change either).
- `walletService` (`src/modules/wallet/`) — `getBalance` / `addCredits` / `debitCredits`, each accepting an optional transaction client. Debits are a conditional `updateMany({ where: { userId, balance: { gte: amount } } })` → an under-funded debit matches zero rows and throws `InsufficientCreditsError` (402) having mutated nothing. `GET /api/wallet/balance` returns the caller's own balance only (userId from the JWT, never the query).
- `IPayoutProvider` contract (`src/modules/payouts/provider.interface.ts`) — `createPayout` / `verifyWebhookSignature` / `parseWebhookEvent`, exported from the module index. No adapter: `// TODO(Session 06): implement PaxumAdapter`.
- `contentService.grantContentAccess` extended with an optional transaction client so subscription grants commit atomically with the payment confirmation (Session 04 logic reused verbatim, not reimplemented).
- Shared: `PAYMENT_CHANNELS`, `CHECKOUT_CHANNELS`, `PAYMENT_PROVIDERS`, `SUBSCRIPTION_TIERS`, `SUBSCRIPTION_PLANS`, `CREDIT_PACKS`, `CHANNEL_CURRENCY`, `findCreditPack`, `ChargePayload` union, `CheckoutResponse`, `WalletBalanceResponse`.
- Web: `/wallet` client page — balance read + credit-pack checkout trigger, renders the PIX QR + copia-e-cola or the crypto address + amount. No payment credential reaches the browser.
- Stripe placeholders purged from all three `.env.example` files and replaced with the Woovi/NOWPayments/channel-selector blocks.
- 54 new tests (107 total, zero regressions); `pnpm turbo run typecheck lint test build` all green.

**Notes / deviations:**
- **HTTP mocking = `nock@14`**, not msw: nock 14 intercepts Node's global `fetch` natively (the exact surface the adapters use), and `nock.disableNetConnect()` makes any un-mocked provider call a hard failure. msw's real advantage — sharing handlers between a browser worker and Node — does not apply to server-side HTTP clients.
- **Idempotency = DB unique constraint, not an application check.** The key is minted at checkout, stored as `PaymentTransaction.idempotencyKey` (UNIQUE), and handed to the provider as its correlation/order id so the webhook echoes it back. Confirmation is a compare-and-set (`WHERE idempotencyKey = ? AND status = 'PENDING'`), so the database decides who wins; an application-level "have I seen this id?" check has a read-then-write window two concurrent deliveries can both pass.
- Woovi PIX subscriptions are **two provider calls** (register the recurrence, then charge period 1) because PIX is a one-shot instrument — even a subscription settles as a charge per period, and the payer needs a QR code immediately.
- NOWPayments recurrence is **best-effort**: plans must pre-exist in their dashboard, so when `NOWPAYMENTS_PLAN_ID_<TIER>` is unset the first period's payment is still created and `providerSubscriptionId` stays null, rather than pretending a recurrence exists.
- Money is stored in **minor units as integers** everywhere (`amount` in centavos/cents); crypto `payAmount` crosses the wire as a decimal **string** because it exceeds what a JS number carries safely.
- Checkout rate limiting is keyed on `userId`, not IP: two subscribers behind one NAT must not exhaust each other's budget, and one account must not get a fresh budget per IP.
- The persisted `provider` column comes from `adapter.name`, not a channel→provider lookup table, so a provider swap is visible in the data with nothing to keep in sync.
- **ARIA validation:** `eslint-plugin-jsx-a11y` (flat config, `**/*.tsx`) added to the root ESLint config — 34 rules active on the wallet page, zero findings. Runs in CI with the rest of lint.

**External Prerequisites:**
- [x] MEI aberto — CNPJ 67.735.318/0001-91 ativo na Receita Federal
- [x] Conta Nubank PJ criada — chave PIX CNPJ vinculada
- [x] Conta Woovi (OpenPix) criada em app.woovi.com — empresa "Creator Platform", CNPJ 67.735.318/0001-91, plano percentual 0,80%
  - [ ] Coletar `OPENPIX_APP_ID` no dashboard → API/Plugins _(code is ready; not needed for tests)_
  - [ ] Coletar `OPENPIX_WEBHOOK_SECRET` no dashboard → Webhooks → criar webhook
- [ ] Criar conta NOWPayments: https://nowpayments.io → Sign Up
  - [ ] Coletar `NOWPAYMENTS_API_KEY` em Store Settings
  - [ ] Coletar `NOWPAYMENTS_IPN_SECRET` em IPN Settings
  - [ ] Conectar carteira USDT TRC-20 em Payout Settings

---

### Session 06 — Revenue Sharing & Payouts ✅ Complete
**File:** `.claude/sessions/session-06.md`  
**Domain:** 80/20 revenue split persisted per transaction, ledger-derived model balance, `PaxumAdapter` on the Session-05 `IPayoutProvider` contract, weekly cron-triggered payout run, Paxum IPN, minimal admin visibility

**Summary:**
- `Payout` model + `PayoutProvider` / `PayoutStatus` enums added to Prisma; `PaymentTransaction` gains `modelShareCents`, `platformShareCents`, `payoutId` (FK, `SetNull`) and an index on `(modelId, payoutId)`; `User` gains a `payouts` relation. Migration `20260901120000_add_payouts` **generated and applied** to Supabase (`prisma migrate deploy` — all 6 migrations now applied, including Session 05's).
- Two CHECK constraints added manually in the migration (Prisma has no CHECK primitive): `PaymentTransaction_revenue_split_exhaustive` — either both shares are null (CREDIT_PACK) or they are non-negative and sum to exactly `amount` — and `Payout_amount_positive`.
- `computeRevenueSplit` (`modules/payouts/revenue.ts`) — `modelShareCents = round(amount × pct / 100)`, `platformShareCents = amount − modelShareCents`. Remainder-to-platform, so no cent is ever lost or invented at any amount or percentage.
- Session 05's webhook confirmation `$transaction` extended: a confirmed **SUBSCRIPTION** stamps the split onto the transaction row (and into the `subscription.activated` audit metadata) in the same transaction that grants access. `CREDIT_PACK` rows leave both shares null. All 109 Session-05 tests still pass unmodified.
- **Balance is derived, never stored** — `SUM(modelShareCents) WHERE modelId = ? AND payoutId IS NULL AND type = 'SUBSCRIPTION' AND status = 'CONFIRMED'`. Paying a model is a *claim* (stamping `payoutId`), not a decrement, so there is no counter to drift.
- `GET /api/payouts/balance` — `authenticate` + `authorize('model')`, userId from the JWT only; returns `{ modelId, availableCents, currency, thresholdCents, eligible }`.
- `PaxumAdapter implements IPayoutProvider` — `createPayout` (batch submit, recipients addressed by Paxum email, minor units formatted as a decimal string), `verifyWebhookSignature` (HMAC-SHA256 hex over the raw body, constant-time), `parseWebhookEvent`. **Field/header names are provisional** — see Open Items.
- `MockPayoutProvider implements IPayoutProvider` — deterministic, zero HTTP; `PAYOUT_PROVIDER=mock` for local dev, mirroring `MockPaymentProvider`.
- `modules/payouts/provider.factory.ts` — `getPayoutProvider()` reads `PAYOUT_PROVIDER`, memoises, throws `PayoutProviderConfigError` on an unknown value; `assertPayoutProviderConfigured()` runs in `buildServer` so a typo crashes at boot.
- `POST /api/payouts/run` — guarded by the `X-Payout-Cron-Secret` header compared with `crypto.timingSafeEqual` (never `===`), rejected 401 before any DB access, rate-limited 2/hour. Groups unclaimed earnings per model in one `groupBy`, skips anything below `PAYOUT_MIN_THRESHOLD_CENTS`, and processes the rest in chunks of 10 via `Promise.allSettled`. Per model: one `$transaction` creates the `PENDING` `Payout` and claims its rows with `updateMany({ where: { id: { in: ids }, payoutId: null } })` — a count mismatch aborts the whole transaction. Provider failure → `Payout` FAILED + `AuditLog` + every attached `payoutId` reset to null, so the balance is payable again next run. Response is aggregate only: `{ processed, skipped, failed, totalCents }`.
- `POST /api/payouts/paxum/webhook` — plugin-scoped raw-body parser (same pattern as payments), signature verified before the first DB statement, 400 on mismatch. `PAID` → conditional `updateMany` (`status IN (PENDING, PROCESSING)`) → `COMPLETED`; `REJECTED` → `FAILED` + release. Replays and unknown correlation ids answer 200 with no side effects.
- `GET /api/payouts` (ADMIN, paginated) and `GET /api/payouts/:payoutId` (ADMIN or the owning MODEL — another model's payout is a **404, not a 403**, so payout ids are not enumerable).
- `.github/workflows/weekly-payout.yml` — `cron: '0 12 * * 1'` (Monday 12:00 UTC), `workflow_dispatch` for a missed week, `concurrency` guard, secret read from the environment so it never reaches the run log.
- Shared: `PAYOUT_PROVIDERS`, `PAYOUT_STATUSES`, `PayoutRecordStatus`, `DEFAULT_REVENUE_SHARE_MODEL_PCT`, `DEFAULT_PAYOUT_MIN_THRESHOLD_CENTS`, `PAYOUT_PERIOD_DAYS`, `PayoutBalanceResponse`, `PayoutRunSummary`, `PayoutListItem`, `PayoutListResponse`, `PayoutDetailResponse`.

**Addendum — `payoutEmail` (same session, before commit):**
- `ModelProfile.payoutEmail String? @unique` added; migration `20260901180000_add_payout_email` **generated and applied** (7 migrations now live). UNIQUE is the real guard: two models pointing at one Paxum address would misroute funds, so the database refuses it rather than trusting an application check.
- `PUT /api/payouts/payout-email` — `authenticate` + `authorize('model')`, userId from the JWT (a `modelId` in the body is ignored), email validated + lowercased + trimmed so casing cannot sidestep the unique index, 10/hour. Writes a `payout.email_changed` `AuditLog` row carrying the previous and new address — this field is "where the money goes", so it is held to the bank-detail bar. A no-op re-submit writes no audit row. 400 malformed / 401 anonymous / 403 subscriber / 404 no profile yet / **409 already claimed** (P2002 surfaced as a clean conflict, never a raw DB error).
- The payout run now sources the recipient from `ModelProfile.payoutEmail` and **never** `User.email`. A model above threshold with no destination is **skipped**, not failed — nothing claimed, balance untouched, `payout.skipped_no_payout_email` audited — mirroring the existing "account no longer exists" path. They are paid on the first run after they set one.
- `GET /api/payouts/balance` gains `payoutEmailConfigured: boolean`. The address itself is not echoed back: that endpoint answers "how much", not "to where".
- 67 payout tests in total (176 across the suite, zero regressions); `pnpm turbo run typecheck lint test build` all green.

**Notes / deviations:**
- **The payout factory lives in `modules/payouts/provider.factory.ts`, not in the payments one.** The spec said "extend `provider.factory.ts`"; extending the payments factory would have made the payments module import a payout adapter, which breaks the money-in/money-out separation the two interfaces exist to enforce. The payouts factory mirrors the payments one line for line — same memoisation, same boot-time assert, same "unknown name crashes rather than falls back".
- **`modules/payouts/adapters/http.ts` deliberately duplicates its payments sibling** rather than importing it: the payments version is typed to `PaymentProviderName` and throws `PaymentProviderError`, and the two error taxonomies are meaningfully different (a failed charge is a 502 to a waiting subscriber; a failed payout rolls a claim back inside a cron run). The signature helpers (`hmac`/`safeEquals`/`headerValue`) *are* reused — they are pure crypto utilities with no payments coupling.
- **Recipient address lives on `ModelProfile.payoutEmail`, set by the model.** Paxum pays into a personal Paxum account whose email need not match the platform login, so there is nothing safe to fall back to — a model without a destination is skipped rather than paid to a guessed address. (Originally shipped using `User.email` and flagged as an Open Item; closed by the addendum above, before commit.)
- **`Payout.status` (`PENDING|PROCESSING|COMPLETED|FAILED`) is our record's state; `PayoutStatus` in `provider.interface.ts` (`PENDING|PAID|FAILED`) is the provider's normalized vocabulary.** They are deliberately distinct — the shared type for ours is `PayoutRecordStatus`.
- **A model whose account has vanished is counted as `skipped`, not `failed`** — the `Payout.modelId` FK means no row can be created for them, so there is nothing to fail. It writes a `payout.skipped_no_recipient` audit entry.
- **`/run` returns aggregates only.** No model ids, no per-model amounts: the caller is a machine holding a shared secret, so the response must not double as a payout-history oracle.
- **ARIA validation:** this session ships no frontend UI. `eslint-plugin-jsx-a11y` (added in Session 05) still runs over `**/*.tsx` in CI with zero findings — lint is green.

**External Prerequisites:**
- [ ] Create Paxum Business account: https://www.paxum.com → sign up as Business
  - Enable mass payout API: contact Paxum support to activate REST API access
  - Each model must also have a personal Paxum account (their email is used as payout recipient)
  - Get `PAXUM_API_KEY` and `PAXUM_IPN_SECRET` from Merchant Services → IPN Settings
- [ ] Generate `PAYOUT_CRON_SECRET` (`openssl rand -hex 32`) and store it, plus `API_PUBLIC_URL`, as GitHub Actions repository secrets

---

### Session 06.5 — Subscription Lifecycle: Renewal & Cancellation ✅ Complete
**File:** `.claude/sessions/session-06.5.md`  
**Domain:** Renewal charge issuance ahead of `currentPeriodEnd`, reminder email, grace period, self-service cancel/resume, honest `Subscription.status`

**Summary:**
- `Subscription.cancelAtPeriodEnd Boolean @default(false)` + `@@index([status, cancelAtPeriodEnd, currentPeriodEnd])` added to Prisma; migration `20260902120000_add_subscription_lifecycle` **generated and applied** (8 migrations now live).
- **New module `modules/subscriptions/`** — lifecycle orchestration kept out of `payments.service.ts`, the same separation Session 06 made between `payouts/` and `payments/`. It creates no charges of its own.
- **One `IPaymentProvider` call site for subscription revenue.** `createSubscriptionCheckout`'s body was extracted into `paymentsService.issueSubscriptionCharge({ userId, modelId, tier, provider })`, called by both the public endpoint and the renewal sweep; the endpoint is now a two-line delegate. All 41 Session-05 payments tests pass unmodified.
- `POST /api/subscriptions/renewals/run` — guarded by `X-Renewal-Cron-Secret` compared with `crypto.timingSafeEqual` against `SUBSCRIPTION_RENEWAL_CRON_SECRET` (never `===`), rejected 401 before any DB access, rate-limited 4/hour (higher than the payout run's 2/hour: a daily job may legitimately need a same-day retry). Four passes, in order:
  1. **Reminders** — `ACTIVE`, `cancelAtPeriodEnd: false`, `currentPeriodEnd` within `SUBSCRIPTION_RENEWAL_REMINDER_DAYS` (default 3) → skip if a `PENDING` `SUBSCRIPTION` transaction already exists for the pair, else `issueSubscriptionCharge` + `sendRenewalReminderEmail`.
  2. **Grace start** — lapsed non-payers `ACTIVE → PAST_DUE`.
  3. **Grace end** — `PAST_DUE` past `currentPeriodEnd + SUBSCRIPTION_GRACE_PERIOD_DAYS` (default 3) → `EXPIRED`.
  4. **Cancellations landing** — `ACTIVE` + `cancelAtPeriodEnd: true` past `currentPeriodEnd` → `CANCELED`, never `PAST_DUE`.
  Response is aggregates only: `{ remindersIssued, movedToPastDue, movedToExpired, movedToCanceled }`.
- `GET /api/subscriptions/me` — `authenticate` + `authorize('subscriber')`, scoped by JWT `userId`; returns `subscriptionId`/`modelId`/`tier`/`status`/`currentPeriodEnd`/`cancelAtPeriodEnd`.
- `POST /api/subscriptions/model/:modelId/cancel` — sets `cancelAtPeriodEnd: true`. Does **not** touch `status` or revoke any `ContentAccess`: the subscriber bought this period and keeps it. Idempotent (200 no-op, no second audit row). Audited with `accessRetainedUntil`.
- `POST /api/subscriptions/model/:modelId/resume` — clears the flag, **only while `status: ACTIVE`**; 409 once the row has moved on (`PAST_DUE`/`EXPIRED`/`CANCELED`) — resubscribing through normal checkout is a simpler mental model than resurrecting a lapsed row. 404 for a pair the caller has no subscription to, identical to the 404 for a nonexistent model.
- `Emailer` gains `sendRenewalReminderEmail(to, params)` — the same Resend seam the auth verification email uses. The reminder carries the actual instrument (PIX copia-e-cola, or crypto address + amount), since the charge is already payable when it is sent. All interpolated values are HTML-escaped.
- `.github/workflows/subscription-renewals.yml` — `cron: '0 6 * * *'` (daily 06:00 UTC), `workflow_dispatch`, `concurrency` guard, secret read from the environment so it never reaches the run log.
- Shared: `DEFAULT_SUBSCRIPTION_RENEWAL_REMINDER_DAYS`, `DEFAULT_SUBSCRIPTION_GRACE_PERIOD_DAYS`, `SubscriptionListItem`, `MySubscriptionsResponse`, `SubscriptionRenewalRunSummary`, `channelForCurrency`.
- 21 new tests (197 total, zero regressions); `pnpm turbo run typecheck lint test build` all green.

**Notes / deviations:**
- **`cancelAtPeriodEnd` is a boolean, not a fifth `SubscriptionStatus`.** `status` answers exactly one question — what access does this subscriber have right now. A subscriber who cancels on day 2 of a 30-day period is still fully `ACTIVE` for 28 more days, because they paid for them. Folding "will renew" into `status` would mean either lying about their access or inventing a `CANCELING` state every access check would then have to learn. As a separate column, no existing access-control code changed at all, and the two terminal outcomes stay queryable apart: `CANCELED` is churn, `EXPIRED` is payment failure.
- **The renewal rail is derived from the currency of the last confirmed payment, not from `Subscription.provider`.** `provider` names an *adapter* (`PAYMENT_PROVIDER_PIX=mock` records `CCBILL_MOCK`), so it cannot answer "which channel". `channelForCurrency` in `@creator-platform/shared` inverts the existing `CHANNEL_CURRENCY` table rather than adding a second mapping that could drift from it. A subscription with no confirmed payment, or a currency no channel bills in, is skipped and audited (`subscription.renewal_skipped_no_channel`) rather than renewed on a guessed rail.
- **Pass 1 runs before pass 2 on purpose.** A subscription that lapsed since the last run (a missed cron day) gets a payable charge in the same sweep that opens its grace window, rather than waiting another day for one.
- **The webhook upsert now also clears `cancelAtPeriodEnd`** — one field beyond what the spec called for. Paying for another period is an unambiguous statement of intent to continue; without it, a subscriber who cancelled and then deliberately re-subscribed would be silently cancelled again at the end of the period they just paid for.
- **The sweep needs none of the payout run's claim/rollback machinery.** It moves no money by itself. Each pass is idempotent by its own query: reminders by the existing-`PENDING` check, transitions by an `updateMany` whose `where` names the status being moved *from*, so a re-run matches zero rows.
- **A bounced reminder email does not undo the charge or fail the run** — the charge is already recorded and payable, the failure is audited (`subscription.renewal_reminder_email_failed`), and tomorrow's run finds it outstanding and issues no second one.
- **Access enforcement was not touched.** `ContentAccess.expiresAt` was already written to expire with `currentPeriodEnd` and is checked live at serve time, so a lapse cuts access off on its own. The status transitions are honest bookkeeping for admin/model reporting; nothing gates on them.
- **ARIA validation:** this session ships no frontend UI. `eslint-plugin-jsx-a11y` (Session 05) still runs over `**/*.tsx` in CI with zero findings — lint is green.

**External Prerequisites:**
- [ ] Generate `SUBSCRIPTION_RENEWAL_CRON_SECRET` (`openssl rand -hex 32`) and store it as a GitHub Actions repository secret (alongside the existing `API_PUBLIC_URL`)

---

### Session 07 — Real-Time Private Messaging ✅ Complete
**File:** `.claude/sessions/session-07.md`  
**Domain:** 1:1 real-time messaging between subscriber and model, subscription-gated send, image/video attachments. No live video/voice calls, no group chats — out of scope by product decision.

**Summary:**
- `Conversation` (`@@unique([subscriberId, modelId])`, indexed on `(modelId, lastMessageAt)` and `(subscriberId, lastMessageAt)`) + `Message` (`attachmentType` enum `IMAGE|VIDEO`, `attachmentStorageKey` never serialized, indexed on `(conversationId, createdAt)` and `senderId`) added to Prisma, plus a hand-written `CHECK` (`body IS NOT NULL OR attachmentType IS NOT NULL`) since Prisma has no CHECK primitive — same pattern as the Session 06 revenue-split constraint. Migration `20260910120000_add_messaging` **generated and applied** to Supabase; all 9 migrations now live.
- **New module `modules/messaging/`** — `messaging.routes.ts` (6 REST endpoints, multipart + `file-type` magic-byte validation, rate limits), `messaging.service.ts` (business logic, storage, fan-out), `messaging.schema.ts` (Zod), `messaging.ws.ts` (WebSocket delivery), `connections.ts` (in-memory `Map<userId, Set<socket>>` registry).
- `POST /api/messages/conversations/:modelId` — subscriber-only, idempotent (201 first call / 200 on repeat, same row), **403 `subscription_required`** without an `ACTIVE` subscription to that model, 404 for an unknown/non-model id.
- `GET /api/messages/conversations` — lists the caller's conversations, other participant, last-message preview (`[image]`/`[video]` when attachment-only), unread count. Exactly 3 queries regardless of conversation count: `conversation.findMany` + one `message.groupBy` (unread) + one `message.findMany` with `distinct: ['conversationId']` (last message per row) — no N+1.
- `GET /api/messages/conversations/:conversationId/messages` — cursor-paginated (`before` + `limit`, max 100) history, participant-only, **404 not 403** for a non-participant (mirrors the Session 06 payout-detail pattern so conversation ids are not enumerable). Never serializes `attachmentStorageKey`.
- `POST /api/messages/conversations/:conversationId/messages` — the **only** place a message is created (the WebSocket does not accept writes — one auditable write path, same discipline as Session 06.5's single `issueSubscriptionCharge` seam). **Live** `Subscription.status === 'ACTIVE'` check on every send when the sender is the subscriber (403 `subscription_inactive` otherwise, re-read fresh each time — never cached from conversation-creation time); the model is never gated and can always reply. History stays readable to both parties regardless of subscription state — nothing already paid for is retroactively hidden. Attachments: magic-byte + declared-Content-Type cross-check, **415** on mismatch or disallowed type, **413** over the 15 MB (image) / 100 MB (video) caps, stored at `messages/{conversationId}/{cuid2}.{ext}`. Rate-limited 60 sends/min/user; reads rate-limited 120/min/user (Claude Code's own addition, approved — history isn't a free firehose).
- `GET /api/messages/attachments/:messageId` — participant-only (404 otherwise), mints a 60-second signed URL, identical TTL/discipline to Session 04's video serving. A message with no attachment is also a 404 — the three "doesn't exist" cases are indistinguishable to the caller.
- `PATCH /api/messages/conversations/:conversationId/read` — marks the other participant's unread messages read; idempotent by its own `where` (`readAt: null`).
- `GET /ws/messages` (`@fastify/websocket`) — authenticated during the upgrade via the existing httpOnly access-token cookie through the `authenticate` hook (never a query-string token), rejects unauthenticated upgrades with 401 before the handshake completes. **Broadcast-only**: inbound frames are never parsed. Capped at 3 concurrent connections per user; over the cap the socket is accepted then closed with a distinguishable close code.
- Shared: `ConversationListItem`, `ConversationSummary`, `MessageItem`, `SendMessageRequest`/`Response`, `MESSAGE_ATTACHMENT_TYPES`, the `message.new` WS event payload type.
- 37 new tests (234 total, zero regressions); `pnpm turbo run typecheck lint test build` all green.

**Notes / deviations:**
- **`MessageAttachmentType` is a new Prisma enum, not a reuse of `ContentType`.** Identical values today, but chat attachments and the monetized content library have different size caps and different futures — widening one must not silently widen the other.
- **Attachment validation failures are 415, not Session 04's 400** — the spec named 415 explicitly for this endpoint; size overruns stay 413, matching Session 04.
- **Error bodies carry machine codes** (`subscription_required`, `subscription_inactive`, `empty_message`, `conversation_not_found`, `attachment_not_found`, …) in the existing `{ error: string }` shape — a UI needs to distinguish "buy a subscription" from "renew a lapsed one."
- **Read-endpoint rate limit (120/min/user)** and the extra `Message.senderId` index were added by Claude Code beyond the literal spec text — both are operational guard-rails, not new features, and are approved.
- **The fan-out registry is process-local (`connections.ts`).** It only reaches recipients connected to the same instance. Fine for a single-instance MVP; horizontal scaling of the API needs a shared pub/sub layer (Redis/NATS) to fan out across processes — flagged as an Open Item, not solved here. The service depends only on an injected `send(userId, event)` seam, so that swap stays in the wiring layer and never touches `messaging.service.ts`.
- **DB connectivity note:** the Supabase project had paused; `prisma migrate deploy` must be run from `apps/api` (or via `pnpm --filter @creator-platform/api exec prisma migrate deploy`) — running it from the repo root can resolve the wrong `prisma` binary entirely (a bare `npx prisma` from a directory with no local install can fetch an unrelated package from the registry, producing CLI errors that don't match Prisma's actual command set at all).

**External Prerequisites:**
- [x] No new external accounts required — self-hosted `@fastify/websocket`, no Pusher/Ably dependency taken

---

### Session 08 — AI Image Personalization ⏳ Pending
**File:** `.claude/sessions/session-08.md`  
**Domain:** Likeness anchor engine, hidden system prompt, preset + custom UI, credit deduction

**External Prerequisites:**
- [ ] Create Replicate account: https://replicate.com → sign up → go to https://replicate.com/account/api-tokens → generate token → copy `AI_PROVIDER_API_KEY`
- [ ] Review SDXL model on Replicate: https://replicate.com/stability-ai/sdxl
- [ ] Add billing method on Replicate (pay-per-use): https://replicate.com/account/billing

---

### Session 09 — Anti-Leak & Content Protection ⏳ Pending
**File:** `.claude/sessions/session-09.md`  
**Domain:** Signed expiring URLs, screenshot deterrents, watermark hardening

**External Prerequisites:**
- [ ] No new external accounts required
- [ ] Storage provider from Session 03 must support signed URLs (Supabase Storage and R2 both do)

---

### Session 10 — i18n & Multilingual ⏳ Pending
**File:** `.claude/sessions/session-10.md`  
**Domain:** PT-BR + EN, i18n framework, all strings externalized

**External Prerequisites:**
- [ ] No new external accounts required

---

### Session 11 — Admin Dashboard ⏳ Pending
**File:** `.claude/sessions/session-11.md`  
**Domain:** Metrics, user management, model approval, payout oversight, moderation

**External Prerequisites:**
- [ ] No new external accounts required
- [ ] (Optional) Analytics: https://posthog.com → create account (free tier) → copy project API key

---

### Session 12 — Security Hardening & Performance Audit ⏳ Pending
**File:** `.claude/sessions/session-12.md`  
**Domain:** OWASP checklist, rate limiting, load test, DB index review

**External Prerequisites:**
- [ ] No new external accounts required
- [ ] (Optional) Upstash Redis for rate limiting: https://upstash.com → create Redis DB → copy `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN`

---

### Session 13 — MVP Deployment ⏳ Pending
**File:** `.claude/sessions/session-13.md`  
**Domain:** Railway/Render/Fly.io deploy, managed DB, domain, SSL, monitoring

**External Prerequisites:**
- [ ] Choose and create hosting account (pick one):
  - Railway: https://railway.app → sign up with GitHub (free trial available)
  - Render: https://render.com → sign up with GitHub (free tier available)
  - Fly.io: https://fly.io → sign up → install flyctl CLI
- [ ] Register a domain (optional at MVP): https://porkbun.com or https://namecheap.com
- [ ] Set up error monitoring: https://sentry.io → create account (free tier) → create project → copy `SENTRY_DSN`
- [ ] (Optional) Uptime monitoring: https://betterstack.com/uptime → free tier available

---

## Architecture Decisions

_Session 01 — all choices prioritize a free tier at MVP, TypeScript-first DX, and easy swap/upgrade later._

- **pnpm workspaces + Turborepo** — strict, symlinked, disk-efficient installs with cached task running. No vendor lock-in; both free.
- **Next.js 14 (App Router)** — SSR/ISR, file-based routing, i18n-ready, deployable to any Node/serverless host.
- **Fastify 5** — leaner than NestJS; upgraded from v4 to v5 in Session 02 to align with plugin ecosystem (@fastify/jwt@10, @fastify/cookie@11, @fastify/rate-limit@11).
- **Prisma + PostgreSQL (Supabase)** — type-safe generated client + migrations; free managed Postgres, no credit card. Generated client outputs to `apps/api/prisma/generated/` (gitignored).
- **Internal packages from source** — `@creator-platform/shared` exposes `src/` directly, no build step in dev.
- **ESLint 9 flat config + Prettier** — single root config governs every package.
- **Vitest** — ESM/TS-native; auth tests inject in-memory Prisma mock + fake emailer so CI stays green with no real DB or email.

_Session 02 — auth-specific decisions:_

- **JWT in httpOnly cookies only** — access token (15m, `JWT_SECRET`) + refresh token (7d, `JWT_REFRESH_SECRET`). Tokens are never returned in response bodies or stored in localStorage.
- **Two namespaced @fastify/jwt registrations** — separate secrets and cookies for access vs refresh tokens. Produces `reply.accessJwtSign` / `request.accessJwtVerify` / etc. Untyped decorators augmented in `src/types/fastify-jwt.d.ts`.
- **SHA-256 pre-digest before bcrypt for refresh tokens** — bcrypt silently truncates input at 72 bytes; a JWT's signature lives past that. Digesting to a fixed 64-char hex string first ensures the full token (signature included) is bound to the stored hash.
- **bcryptjs** — pure JS, avoids native build issues in CI/serverless environments.
- **Zod via manual `safeParse`** — validation at route handlers without a bridge dependency. Sufficient for MVP scale.
- **Resend** — transactional email via SDK (`resend` npm package); `Emailer` interface allows swapping providers without touching auth code.
- **Startup env validation** — `src/lib/env.ts` validates required secrets eagerly at boot; process crashes with a clear error if any are missing (never fails silently at first request).

_Session 04 — content-specific decisions:_

- **`storageKey` is layer-private** — it never enters a response body, header, or error. Delivery is exclusively via short-TTL signed URLs (≤300s thumbnails, 60s video) or on-the-fly watermarked byte streams; the serve path streams bytes directly, not a signed URL.
- **`ImageProcessor` interface (sharp-backed)** — image work sits behind an injectable interface like `StorageClient`/`Emailer`, so tests inject a fake and CI never loads sharp's native binary. Watermark is an SVG overlay (per-user: brand + email), images capped at 2048px before processing for the <500ms budget.
- **Per-user watermark ⇒ `Cache-Control: no-store`** — watermarked images are unique per requester, so they must never be cached by browsers/proxies.
- **Tier access via `ContentAccess` rows** — a `contentId+userId` join with `grantReason` + optional `expiresAt`, checked server-side on every serve/list. `grantContentAccess`/`revokeContentAccess` are the write primitives Session 05's payment webhooks will call.
- **`cuid2` for storage keys** — collision-resistant content IDs in `content/{modelId}/{cuid2}.{ext}`.

_Session 05 — payments implementation decisions:_

- **Idempotency lives in the database, not in application logic.** The correlation id minted at checkout is stored as `PaymentTransaction.idempotencyKey` (UNIQUE) and handed to the provider as its correlation/order id, so the webhook echoes it back. Confirmation is a compare-and-set — `updateMany({ where: { idempotencyKey, status: 'PENDING' } })` — so Postgres arbitrates: a replay matches zero rows and the credit/grant never runs, and two concurrent deliveries serialize on the row lock. An application-level "have I seen this id?" check has a read-then-write window both deliveries can pass through.

- **One `$transaction` per confirmed event.** The status claim, the wallet credit (or subscription upsert + `ContentAccess` grants), and the `AuditLog` row commit together. There is no instant at which a transaction reads CONFIRMED but the thing it paid for has not been granted.

- **Raw bytes for signature verification.** A JSON content-type parser scoped to the payments plugin keeps `request.rawBody`; re-serializing the parsed body changes key order and whitespace, and the digest with it. Verification runs before the first database statement, so a forged callback costs one HMAC.

- **Prices come from a server-side catalog.** `SUBSCRIPTION_PLANS` and `CREDIT_PACKS` in `@creator-platform/shared` are the only source of an amount; checkout schemas have no `amount` field, so a client can choose *what* to buy but never *for how much*.

- **Money is integer minor units.** Every persisted amount is centavos/cents as an `Int`. Crypto `payAmount` crosses the wire as a decimal string — it carries more precision than a JS number holds safely.

- **Balances cannot go negative by construction.** `debitCredits` is a conditional update (`WHERE userId = ? AND balance >= ?`); an under-funded debit matches zero rows and throws, with a `CHECK (balance >= 0)` constraint as backstop. No read-then-write, no partial mutation.

- **`nock@14` over msw for adapter tests.** nock 14 intercepts Node's global `fetch` natively — the exact surface the adapters use — and `nock.disableNetConnect()` turns any un-mocked provider call into a hard failure. msw's advantage is sharing handlers between a browser worker and Node, which does not apply to server-side HTTP clients.

- **`mock` is a valid pix/crypto adapter in development.** It makes checkout work before the Woovi and NOWPayments merchant accounts are approved, and it is what proves the abstraction holds: flipping `PAYMENT_PROVIDER_PIX` swaps the class with no other change. The **card** channel still accepts `mock` and nothing else — CCBill must be wired in deliberately, never by flipping an env var.

- **Checkout rate limits key on `userId`, not IP.** Two subscribers behind one NAT must not exhaust each other's budget, and one account must not earn a fresh budget per IP.

_Session 06 — payouts implementation decisions:_

- **A model's balance is a query, not a column.** `SUM(modelShareCents) WHERE modelId = ? AND payoutId IS NULL` is the whole definition of "what we owe you". Paying is a *claim* — stamping `payoutId` onto the rows that funded the payout — never a decrement of a counter. A counter can drift from the rows that justify it, and reconciling a drifted financial counter after the fact is not something a weekly cron job can do. Same ledger-over-counter reasoning as Session 05's `debitCredits`, applied to money out.

- **The split is stamped at confirmation, not computed at payout time.** `modelShareCents`/`platformShareCents` are written in the same `$transaction` that confirms the payment, so the row records what was owed under the terms in force *then*. Changing `REVENUE_SHARE_MODEL_PCT` next month therefore cannot silently rewrite what a model already earned. Rounding is remainder-to-platform (`platform = amount − model`), backed by a CHECK constraint, so no cent leaks or is invented.

- **Claiming is compare-and-set, and failure releases the claim.** The run creates the `Payout` and claims its transactions in one `$transaction` with `updateMany({ where: { id: { in: ids }, payoutId: null } })`; if the matched count differs from what was selected, another run got there first and the whole transaction aborts. If the provider then rejects the batch, the `Payout` goes FAILED and every `payoutId` is reset to null — the earnings simply reappear in next week's balance. There is no state in which money is claimed but unpayable.

- **`/payouts/run` is guarded by a service secret, not an admin JWT.** The caller is a GitHub Actions cron job: it has no user session, so it has no JWT to present and no way to get one without holding a real admin password — and there is no admin auth or dashboard yet (Session 11). A shared secret in a header authenticates the *machine* honestly, is compared with `crypto.timingSafeEqual`, rejects before any DB access, is rate-limited 2/hour so a leaked secret cannot trigger unlimited runs, and rotates in one GitHub secret.

- **Below-threshold balances need no carry-over bookkeeping.** A model under `PAYOUT_MIN_THRESHOLD_CENTS` is skipped, their rows keep `payoutId = null`, and the same balance query picks them up next week. The carry-over falls out of the ledger rather than being a second thing to maintain.

- **Models are processed in chunks of 10 via `Promise.allSettled`** — not sequentially (one slow Paxum call would stall the run) and not all at once (a thousand models would open a thousand sockets and trip the provider's rate limits). One failing model is one `failed` in the summary, not a dead run.

- **Credit-pack revenue is deliberately out of the split.** Credits are a wallet-wide balance with no per-model attribution until AI generation ships (Session 08), so there is nothing honest to split; `CREDIT_PACK` rows leave both shares null rather than carrying an invented number.

- **A payout destination is never inferred.** `ModelProfile.payoutEmail` is set explicitly by the model, is UNIQUE at the database level, and every change is audit-logged with its previous value. Falling back to `User.email` would have been convenient and wrong: Paxum pays into a personal account whose address need not match the login, and a wrong address is an irreversible transfer, not a validation error. A model without one is skipped — the balance is safe where it is.

- **`PaxumAdapter` ships pre-approval, like Woovi and NOWPayments did.** The Business account is not approved, so the wire format is written against Paxum's publicly documented mass-payout mechanics and exercised only against `nock`. Every provisional name is marked as such in the adapter and tracked as an Open Item. What is *not* provisional is the seam: correcting a field name later touches one class.

_Session 06.5 — subscription lifecycle decisions:_

- **"Will it renew" is a separate column from "what access is live".** `Subscription.status` means one thing: the subscriber's current access state. `cancelAtPeriodEnd` means another: whether a renewal charge will be issued. Merging them into a fifth status value would force every access check to learn a `CANCELING` state that grants full access — or force us to mark someone `CANCELED` while they still have 28 paid-for days. Kept apart, no access-control code changed at all, and churn (`CANCELED`) stays queryable apart from payment failure (`EXPIRED`), which are different business signals.

- **Renewal is a fresh charge, not a stored mandate.** PIX and crypto are one-shot instruments: there is nothing to pull from. So the sweep issues a new charge a few days early, emails it, and allows a grace window after the period ends — a design that works identically for both rails through the existing `IPaymentProvider`. Woovi's Pix Automático (a BACEN recurring mandate) would improve this for PIX subscribers specifically, and is tracked as a future candidate rather than built here.

- **One `IPaymentProvider` call site for subscription revenue.** `issueSubscriptionCharge` is called by both the checkout endpoint and the renewal sweep. A renewal is not a different kind of payment, and duplicating the call site would have meant two places to keep the catalog price, the eligibility gates and the idempotency key in step.

- **The sweep is idempotent by query, not by claim.** Unlike the payout run it moves no money by itself, so it needs no claim/rollback machinery: reminders are guarded by "does an unpaid `SUBSCRIPTION` charge already exist for this pair", and each transition is an `updateMany` whose `where` names the status being moved *from*. Re-running matches zero rows.

- **The renewal rail comes from the last confirmed payment's currency.** `Subscription.provider` names an adapter, not a channel, so it cannot answer which rail to renew on. `channelForCurrency` inverts the existing `CHANNEL_CURRENCY` table instead of introducing a second mapping to keep in sync; a subscription with no confirmed payment is skipped and audited rather than renewed on a guess.

_Session 07 — real-time messaging decisions:_

- **`@fastify/websocket`, self-hosted, over a managed pub/sub.** It runs inside the existing Fastify process, so real-time delivery costs no new hosted service and needs no second identity system — the socket authenticates through the same httpOnly cookie and `authenticate` hook the REST routes already use, because a WebSocket upgrade is still an HTTP request. Pusher/Ably (CLAUDE.md's original "optional" prerequisite) would mean paying per connection and shipping the subscriber graph to a third party for something a single MVP instance serves for free. Socket.IO was rejected too — its own protocol, client library and room semantics solve problems this session doesn't have.

- **The WebSocket is broadcast-only; there is exactly one place a message is written.** `POST /api/messages/conversations/:id/messages` is the only creation path — the socket ignores every inbound frame. This is the same "one call site" discipline as Session 06.5's `issueSubscriptionCharge`: one path to validate, gate and rate-limit, with fan-out reduced to a pure read-side concern.

- **Subscription gating is re-read live on every send, never cached from conversation creation.** A subscriber's `Subscription.status` can change (lapse, cancel, resume) between opening a conversation and sending message #50; caching the check at creation time would let a lapsed subscriber keep messaging indefinitely. The model is never gated by the same check — blocking a model from answering a paying customer's last message because that customer's billing lapsed would be the wrong failure mode for a creator-monetization product.

- **404, not 403, for a non-participant on any conversation/message/attachment endpoint.** Identical reasoning to Session 06's payout-detail endpoint: a 403 confirms the id exists, turning it into an enumeration oracle. A 404 makes "wrong id" and "not yours" indistinguishable.

- **`attachmentStorageKey` never leaves the service layer.** `toMessageItem` (the only function that turns a `Message` row into client-visible JSON) has no field for it — the same "not in the output type, so no caller can leak it by forgetting to strip it" property `Content.storageKey` and `ReferenceImage.storageKey` already have. Delivery is exclusively a 60-second signed URL, minted per-request after a participation check.

- **`MessageAttachmentType` is its own enum, not a reuse of `ContentType`.** Chat attachments (15 MB image / 100 MB video cap) and the monetized content library (50 MB / 500 MB) are different products with different futures; sharing an enum would couple caps that need to move independently.

- **The fan-out registry (`connections.ts`) is process-local by design, not by oversight.** A single MVP instance needs nothing more elaborate than an in-memory `Map<userId, Set<socket>>`. Horizontal scaling of the API would need a shared layer (Redis pub/sub or similar) so an event reaches a recipient connected to a *different* process — logged as an Open Item, deliberately not solved in this session. The service only depends on an injected `send(userId, event)` seam, so that swap stays in the wiring layer.

_Post-Session 05 — scope correction:_

- **PPV was scaffolded in Session 04 but is out of product scope (see original brief) — removed in a post-Session-05 correction; access to PREMIUM content is subscription-only.** `Content.ppvPriceCents` dropped (migration `20260831025136_remove_ppv`), the `ppv_purchase` grant reason retired, and `resolveAccess` now admits PREMIUM on `subscription_premium` alone (owner/admin unchanged).

_Pre-Session 05 — payment stack decisions (Stripe permanently excluded):_

- **Stripe is off-limits** — Stripe explicitly prohibits adult content, AI-generated adult content, and credit-based adult platforms. Account terminations occur without warning. This is a hard, permanent constraint.

- **All Brazilian-based processors are off-limits** — PagBank, Pagar.me, Mercado Pago, Transfeera, OrendaPay, SyncPay, Kirvano all operate under Banco Central do Brasil / Visa/Mastercard network policies that exclude adult content. Attempting to use them risks permanent account termination and MATCH list placement.

- **Woovi (OpenPix) as PIX provider (MVP)** — Brazilian fintech with CNPJ verificável, PCI DSS compliant, API REST documentada com SDK Node.js oficial. Plano percentual: 0,80% por transação (mín R$0,50 / máx R$5,00), zero setup/monthly fee. Liquidação imediata na conta Nubank PJ vinculada. Conta criada com MEI CNPJ 67.735.318/0001-91. Webhooks em tempo real com validação de assinatura. Provider swap-ready via `WooviPixAdapter implements IPaymentProvider`.

- **NOWPayments as crypto gateway (MVP)** — 0.5% service fee per transaction (1% with auto-conversion); zero setup/monthly fee. 350+ cryptocurrencies including USDT, USDC, BTC, ETH, SOL. Native recurring subscription API. Adult content explicitly permitted by ToS (prohibits only illegal/non-consensual material, not consensual adult entertainment). Forbes Advisor #1 crypto gateway 2025. 4.4/5 Trustpilot (850+ reviews). Non-custodial settlement available. Confirmed operational in iGaming and adult verticals.

- **CCBill as future card processor (deferred, post-MVP)** — CCBill is the confirmed and locked card processor for international Visa/Mastercard when the platform is ready. The deferral reason is purely financial: Visa ($950/yr) + Mastercard ($500/yr) = $1,450/yr in mandatory high-risk registration fees imposed by the card networks themselves (not CCBill-specific — every adult card processor passes these fees). When MVP revenue justifies this cost, CCBill activation requires: merchant account application (3–7 days approval), plus `CCBILL_ACCOUNT_NUMBER`, `CCBILL_SUBACCOUNT`, `CCBILL_SALT`, `CCBILL_API_USERNAME`, `CCBILL_API_PASSWORD`. The `CCBillAdapter` implementing `IPaymentProvider` is scaffolded but mocked at MVP. **Do not replace CCBill with any other card processor without explicit approval.**

- **MCC miscoding risk** — operating adult content under a non-adult MCC (e.g., 7372 SaaS, 7375 data services) to avoid high-risk fees constitutes transaction laundering. This risks permanent MATCH list placement, which bars the business from all major card processors for up to 5 years. The platform's actual content scope must drive MCC selection.

- **"Token domain" anti-pattern rejected** — creating a separate domain/company to sell payment tokens and use them on the adult platform was evaluated and rejected. This structure constitutes transaction laundering, violates processor ToS, and risks permanent blacklisting across all processors.

- **Telegram Stars — secondary/optional channel** — Stars can be used for low-ticket microtransactions (tips, supplementary credits) on Telegram bots/channels. Not a primary revenue stream due to: ~32% effective fee on mobile purchases (30% Apple/Google + ~2-3% Fragment); 21-day hold before withdrawal; 1,000 Stars minimum withdrawal; iOS filtering of explicit content by App Store policy; withdrawal goes to TON cryptocurrency (requires exchange → fiat). Integrate only as a supplementary channel if there is an active Telegram community.

- **IPaymentProvider + IPayoutProvider abstractions** — all three payment channels (PIX, crypto, card) implement `IPaymentProvider`. The active provider per channel is selected at startup via env var. Business logic (credit wallet, subscription grants, revenue share) calls only the interface. Swapping a provider = swap the adapter class only.

- **Credit wallet model** — credits are an internal currency. `CreditWallet` table tracks balance per user. Purchase (Woovi PIX webhook / NOWPayments IPN) → credit balance up. AI image generation → credit balance down. No payment triggered at generation time. Subscription grants → `ContentAccess` rows via `grantContentAccess`.

**Swap-readiness notes:** DB provider swappable behind Prisma; AI provider behind `AI_PROVIDER` env switch; storage behind S3-compatible env vars; email provider behind the `Emailer` interface; image processing behind the `ImageProcessor` interface; PIX payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_PIX` env); crypto payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_CRYPTO` env); card payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_CARD` env, mocked until CCBill activation); payout provider behind `IPayoutProvider` (`PAYOUT_PROVIDER` env — `PaxumAdapter` / `MockPayoutProvider`, Session 06). All three payment channels were exercised through the abstraction in Session 05: swapping `PAYMENT_PROVIDER_PIX` from `woovi` to `mock` changes the adapter class and nothing else.

---

## Repository Structure

```
creator-platform/
├── apps/
│   ├── web/                         # Next.js 14 App Router (@creator-platform/web)
│   │   ├── src/app/layout.tsx
│   │   ├── src/app/page.tsx
│   │   ├── src/app/wallet/page.tsx  # balance + credit-pack checkout (Session 05)
│   │   ├── next.config.mjs
│   │   ├── tsconfig.json
│   │   └── .env.example
│   └── api/                         # Fastify 5 backend (@creator-platform/api)
│       ├── src/
│       │   ├── index.ts             # Server bootstrap, plugin registration, /health
│       │   ├── lib/
│       │   │   ├── env.ts           # Startup env validation (crash if secrets missing)
│       │   │   ├── prisma.ts        # Singleton PrismaClient
│       │   │   ├── email.ts         # Resend emailer + Emailer interface
│       │   │   ├── storage.ts       # S3-compatible StorageClient (+ getObject)
│       │   │   └── image.ts         # Injectable ImageProcessor (sharp): dims + watermark
│       │   ├── middleware/
│       │   │   └── auth.ts          # authenticate + authorize RBAC preHandler hooks
│       │   ├── modules/
│       │   │   ├── auth/
│       │   │   │   ├── auth.routes.ts
│       │   │   │   ├── auth.service.ts
│       │   │   │   ├── auth.schema.ts
│       │   │   │   └── auth.test.ts     # 17 tests
│       │   │   ├── onboarding/
│       │   │   │   ├── onboarding.routes.ts
│       │   │   │   ├── onboarding.service.ts
│       │   │   │   ├── onboarding.schema.ts
│       │   │   │   └── onboarding.test.ts   # 21 tests
│       │   │   ├── content/
│       │   │   │   ├── content.routes.ts
│       │   │   │   ├── content.service.ts
│       │   │   │   ├── content.schema.ts
│       │   │   │   └── content.test.ts      # 15 tests
│       │   │   ├── wallet/                  # credit wallet (Session 05)
│       │   │   ├── payments/                # money IN (Session 05)
│       │   │   │   ├── adapters/            # woovi, nowpayments, mock, http, signature
│       │   │   │   ├── provider.interface.ts + provider.factory.ts
│       │   │   │   ├── payments.routes.ts / .service.ts / .schema.ts
│       │   │   │   └── payments.test.ts     # 41 tests
│       │   │   └── payouts/                 # money OUT (Session 06)
│       │   │       ├── adapters/            # paxum, mock, http
│       │   │       ├── provider.interface.ts + provider.factory.ts
│       │   │       ├── revenue.ts           # computeRevenueSplit (80/20)
│       │   │       ├── payouts.routes.ts / .service.ts / .schema.ts
│       │   │       └── payouts.test.ts      # 67 tests
│       │   ├── subscriptions/               # lifecycle (Session 06.5)
│       │   │   ├── subscriptions.routes.ts / .service.ts / .schema.ts
│       │   │   └── subscriptions.test.ts    # 21 tests
│       │   ├── test/
│       │   │   └── fake-prisma.ts           # shared in-memory Prisma stand-in
│       │   └── types/
│       │       └── fastify-jwt.d.ts
│       ├── prisma/
│       │   ├── schema.prisma        # User, ModelProfile (+payoutEmail), Content, payments (+cancelAtPeriodEnd) + Payout models + enums
│       │   ├── migrations/          # …_add_user_model, …_add_model_profile, …_add_content_management, …_add_payments, …_remove_ppv, …_add_payouts, …_add_payout_email, …_add_subscription_lifecycle
│       │   └── generated/           # Prisma client output (gitignored)
│       ├── scripts/
│       │   └── postinstall.mjs
│       ├── vitest.config.ts
│       ├── vitest.setup.ts
│       ├── tsconfig.json
│       └── .env.example
├── packages/
│   └── shared/                      # Framework-free types/constants/utils
│       └── src/index.ts             # Role, JwtPayload, AuthUser + locale/currency constants
├── .github/workflows/
│   ├── ci.yml
│   ├── weekly-payout.yml            # Mon 12:00 UTC → POST /api/payouts/run
│   └── subscription-renewals.yml    # daily 06:00 UTC → POST /api/subscriptions/renewals/run
├── .claude/sessions/
├── tsconfig.base.json
├── turbo.json
├── eslint.config.mjs
├── .prettierrc / .prettierignore
├── pnpm-workspace.yaml
├── .env.example
├── CLAUDE.md
└── README.md
```

---

## Environment Variables Required

Templates live in `.env.example` (root) and `apps/api/.env.example`.
All `.env*` files are gitignored; examples contain placeholders only.

| Variable | Scope | Session | Purpose |
|---|---|---|---|
| `DATABASE_URL` | api | 01 | Supabase Postgres connection string |
| `JWT_SECRET` | api | 02 | Access token signing secret (min 32 chars) |
| `JWT_REFRESH_SECRET` | api | 02 | Refresh token signing secret (min 32 chars, different value) |
| `JWT_EXPIRES_IN` | api | 02 | Access token lifetime (`15m`) |
| `JWT_REFRESH_EXPIRES_IN` | api | 02 | Refresh token lifetime (`7d`) |
| `EMAIL_API_KEY` | api | 02 | Resend API key (`re_…`) |
| `EMAIL_FROM` | api | 02 | Sender address (`noreply@yourdomain.com`) |
| `APP_URL` | api | 02 | Allowed CORS origin + base URL for email links |
| `API_PORT` | api | 01 | Fastify listen port (default `4000`) |
| `NODE_ENV` | both | 01 | Runtime environment |
| `STORAGE_ENDPOINT` / `STORAGE_BUCKET` / `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | api | 03 | Object storage |
| `STORAGE_REGION` | api | 03 | SigV4 signing region (default `us-east-1`) |
| `PAYMENT_PROVIDER_PIX` | api | 05 | Active PIX adapter: `woovi` |
| `OPENPIX_APP_ID` | api | 05 | Woovi (OpenPix) App ID — Dashboard → API/Plugins |
| `OPENPIX_WEBHOOK_SECRET` | api | 05 | Woovi webhook signature secret — Dashboard → Webhooks |
| `OPENPIX_API_URL` | api | 05 | Woovi API base URL (default `https://api.woovi.com`) |
| `PAYMENT_PROVIDER_CRYPTO` | api | 05 | Active crypto adapter: `nowpayments` |
| `NOWPAYMENTS_API_KEY` | api | 05 | NOWPayments API key |
| `NOWPAYMENTS_IPN_SECRET` | api | 05 | NOWPayments IPN (webhook) secret |
| `NOWPAYMENTS_API_URL` | api | 05 | NOWPayments API base URL (default `https://api.nowpayments.io`) |
| `NOWPAYMENTS_PLAN_ID_STANDARD` / `_PREMIUM` | api | 05 | Optional recurring-plan ids; blank = skip provider-side recurrence |
| `API_PUBLIC_URL` | api | 05 | Internet-reachable base URL the providers post webhooks to |
| `PAYMENT_PROVIDER_CARD` | api | 05 | Active card adapter: `mock` (CCBill when activated post-MVP) |
| `CCBILL_ACCOUNT_NUMBER` | api | _post-MVP_ | CCBill main account number (6-digit) — deferred |
| `CCBILL_SUBACCOUNT` | api | _post-MVP_ | CCBill subaccount number (4-digit) — deferred |
| `CCBILL_SALT` | api | _post-MVP_ | CCBill webhook HMAC salt — deferred |
| `CCBILL_API_USERNAME` | api | _post-MVP_ | CCBill REST API username — deferred |
| `CCBILL_API_PASSWORD` | api | _post-MVP_ | CCBill REST API password — deferred |
| `PAYOUT_PROVIDER` | api | 06 | Active payout adapter: `paxum` (or `mock` for offline dev) |
| `PAXUM_API_KEY` | api | 06 | Paxum REST API key for mass payouts |
| `PAXUM_IPN_SECRET` | api | 06 | Paxum IPN shared secret for webhook validation |
| `PAXUM_API_URL` | api | 06 | Paxum API base URL (default `https://api.paxum.com`) |
| `PAYOUT_CRON_SECRET` | api | 06 | Shared secret for `POST /api/payouts/run` (timing-safe compare); mirrored as a GitHub Actions repo secret |
| `REVENUE_SHARE_MODEL_PCT` | api | 06 | Model's cut of a confirmed subscription, whole percent (default `80`) |
| `PAYOUT_MIN_THRESHOLD_CENTS` | api | 06 | Minimum payable balance in minor units (default `5000` = R$50) |
| `PAYOUT_CURRENCY` | api | 06 | Currency Paxum settles payouts in (default `BRL`) |
| `SUBSCRIPTION_RENEWAL_CRON_SECRET` | api | 06.5 | Shared secret for `POST /api/subscriptions/renewals/run` (timing-safe compare); mirrored as a GitHub Actions repo secret |
| `SUBSCRIPTION_RENEWAL_REMINDER_DAYS` | api | 06.5 | Days before `currentPeriodEnd` the renewal charge + reminder go out (default `3`) |
| `SUBSCRIPTION_GRACE_PERIOD_DAYS` | api | 06.5 | Days a non-payer stays `PAST_DUE` before `EXPIRED` (default `3`) |
| `AI_PROVIDER` / `AI_PROVIDER_API_KEY` | api | 08 | AI image provider switch + key (Replicate) |
| `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_API_URL` | web | — | Public URLs for the web app |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | web | 10 | Default UI locale (`pt-BR` \| `en`) |

---

## Open Items / Known Issues

- `.turbo/` cache folder should be added to `.gitignore` (minor, non-blocking)
- No frontend auth UI yet — login/register pages arrive in a future session
- Free-tier first: all tooling choices must have a usable free tier at MVP
- Architecture must allow swapping to paid/robust tiers without a major refactor
- **Video watermarking out of scope** (Session 04) — no ffmpeg/ffprobe; videos are served via a 60s signed URL with no server-side watermark. Harden in Session 09.
- **Content uploads buffer the full file into memory before storage write** (Session 04) — acceptable at MVP; true streaming needs the S3 multipart upload API (deferred).
- **Soft-deleted content objects are left in storage** (Session 04) — a cleanup job to purge `deletedAt` rows' objects is deferred (Session 09/12 candidate).
- **Locked-teaser listing deferred** (Session 04) — the list endpoint hides inaccessible gated content rather than returning it with a null thumbnail; revisit if the UI wants upsell teasers.
- ~~**Session 05 migration not yet applied**~~ — **resolved in Session 06.** The Supabase host was reachable again; `npx prisma migrate deploy` applied `20260830120000_add_payments`, `20260831025136_remove_ppv` and `20260901120000_add_payouts`. `prisma migrate status` reports all 6 migrations applied.
- **Provider request/response shapes need live verification** (Session 05) — the Woovi and NOWPayments adapters were written against published API docs and exercised only against nock-mocked HTTP, because neither merchant account is approved yet. Re-verify field names (`charge.brCode`, `charge.transactionID`, `pay_address`, `pay_amount`, the `x-webhook-signature` / `x-nowpayments-sig` schemes) against a live sandbox charge before going to production.
- **Paxum request/response shapes need live verification** (Session 06) — the `PaxumAdapter` was written against Paxum's publicly documented mass-payout *mechanics* (Paxum-to-Paxum P2P by recipient email, batch submit, asynchronous IPN confirmation, major-unit decimal amounts) and exercised only against nock-mocked HTTP, because the Business account is not approved yet. **These are provisional, not confirmed fact:** the `POST /v1/mass-payouts` path, the `x-api-key` auth header, the request keys (`payments[].correlationId` / `recipientEmail` / `amount` / `currency`, `callbackUrl`), the response keys (`batchId`, `payments[].transactionId` / `status` / `errorMessage`), the `x-paxum-signature` header, and the HMAC-SHA256-hex-over-raw-body IPN scheme. Re-verify every one against a live sandbox batch before production. All of it is confined to `paxum.adapter.ts` behind `IPayoutProvider`.
- ~~**Models are paid at their platform account email**~~ — **resolved by the Session 06 addendum.** `ModelProfile.payoutEmail` (nullable, UNIQUE) is now the payout destination, set by the model through `PUT /api/payouts/payout-email` and audited on every change. `User.email` is never used as a payout address. A model who has not set one is **skipped** by a run (`payout.skipped_no_payout_email`), so their balance stays payable rather than being sent to a wrong address. `GET /api/payouts/balance` returns `payoutEmailConfigured` so a UI can prompt for it. Migration `20260901180000_add_payout_email` applied.
- **Payout earnings are summed in minor units without FX conversion** (Session 06) — the balance query sums `modelShareCents` across currencies, and a claim whose rows disagree falls back to `PAYOUT_CURRENCY`. Harmless while PIX/BRL dominates; a model earning in both BRL (PIX) and USD (crypto) needs per-currency payouts and an FX policy. Candidate: Session 11 alongside the admin dashboard.
- **Credit-pack revenue is not shared with models** (Session 06, by design) — credits are a wallet-wide balance with no per-model attribution until AI generation ships. Extending payouts to cover credit spend is explicit Session 08 follow-up work, once generation events carry a `modelId`.
- **No `Payout` reconciliation job** (Session 06) — a `PROCESSING` payout whose IPN never arrives stays `PROCESSING` forever; there is no sweeper that re-queries Paxum for stale batches. Add one when real volume exists (Session 11/12 candidate).
- ~~**Subscription renewal and cancellation are not implemented**~~ — **resolved in Session 06.5.** A daily cron-triggered sweep (`POST /api/subscriptions/renewals/run`) issues a renewal charge + reminder email before `currentPeriodEnd`, walks lapsed non-payers `ACTIVE → PAST_DUE → EXPIRED` across a configurable grace window, and lands opted-out subscribers on `CANCELED`. `Subscription.cancelAtPeriodEnd` (migration `20260902120000_add_subscription_lifecycle`, applied) backs self-service `POST /model/:modelId/cancel` and `/resume`.
- **Pix Automático is a future upgrade, not a blocker** (Session 06.5) — Woovi supports Pix Automático, BACEN's recurring-mandate scheme, which would let a PIX subscription be pulled automatically instead of re-charged and re-paid each period. It is a separate, larger retrofit (mandate registration and its own consent/cancellation lifecycle, PIX-only, no crypto equivalent), so Session 06.5 deliberately shipped manual renewal that works identically on both rails. Revisit once PIX renewal volume makes the drop-off from manual payment measurable — candidate alongside Session 11/12.
- **Renewal charges accumulate as `PENDING` rows when never paid** (Session 06.5) — an unpaid renewal charge stays `PENDING` forever, and that is exactly what keeps the sweep idempotent (it is the "already charged" marker). Harmless at MVP, but there is no expiry sweep, so a long-churned subscriber leaves one stale row per model. Fold into the reconciliation job flagged for Session 11/12.
- **Renewal reminders are not internationalized** (Session 06.5) — the reminder email is English-only, like the verification email. Both are externalized in Session 10 (i18n).
- **Content published after a subscription starts is not auto-granted** (Session 05) — `ContentAccess` rows are written at confirmation time for the model's then-published catalogue. New uploads mid-period need either a grant-on-publish hook or a subscription-aware check in `resolveAccess`. Revisit when upload cadence matters.
- **Woovi adult content policy** — Woovi/OpenPix é um gateway PIX brasileiro regulado. Antes de ir ao ar em produção com conteúdo explícito adulto, confirmar com o suporte deles (suporte@woovi.com) se aceitam plataformas adult 18+. PIX em si não tem restrição de conteúdo (é infraestrutura do Banco Central), mas o gateway pode ter política própria.
- **CCBill deferred to post-MVP** — $1,450/yr Visa+MC registration fees make card processing financially unviable at MVP stage. CCBill slot is scaffolded as `MockPaymentProvider`. Activate when monthly revenue covers the annual fee.
- **NOWPayments crypto-to-fiat conversion** — NOWPayments settles in cryptocurrency. To receive BRL/USD fiat, platform must maintain exchange accounts (Bybit/OKX/Binance) and execute regular USDT→fiat withdrawals. This is an operational step outside the codebase.
- **Lei FELCA compliance (Brazil)** — Lei 15.211/2025 requires adult platforms to implement CPF + Face ID age verification by 17/03/2026. Penalties: up to R$50M or 10% of annual Brazil revenue. Must be scoped into a future session (candidate: Session 09 or a new Session 9.5). ANPD is the enforcement authority.
- **Paxum → Woovi/NOWPayments wire** — model payouts via Paxum require the platform to accumulate earnings from Woovi and NOWPayments, then fund the Paxum business account. Still a manual treasury step outside the codebase (Session 06 automates the *distribution*, not the *funding*); document the SOP before the first live run.
- **MEI faturamento limit** — MEI CNPJ 67.735.318/0001-91 has R$130k/year revenue cap. When platform revenue approaches this threshold, migrate to ME (Microempresa) with a contador. This unlocks higher volume and formal payroll if needed.
- **Telegram Stars** — optional secondary channel for microtransactions on Telegram bots. ~32% effective fee on mobile purchases. 21-day withdrawal hold. iOS restrictions on adult content via Stars. Not a primary payment channel — integrate only if there is an active Telegram community.
- **Messaging fan-out is process-local, not horizontally scalable** (Session 07) — `connections.ts` holds an in-memory `Map<userId, Set<socket>>`. A recipient connected to a different API instance never receives the live push (they still see the message on next history fetch — nothing is lost, just not real-time across instances). Needs a shared pub/sub (Redis or similar) before running more than one API instance. Candidate: Session 12/13 alongside deployment.
- **`npx prisma` must be run from `apps/api`, not the repo root** (Session 07 tooling note) — in this pnpm workspace, `prisma` is a devDependency of `@creator-platform/api` only. Running a bare `npx prisma migrate deploy` from the monorepo root can resolve an unrelated package instead of the pinned local CLI, producing confusing errors with no resemblance to Prisma's actual command set. Always `cd apps/api` first, or use `pnpm --filter @creator-platform/api exec prisma <command>`.

---

## Last Updated — Session 07 complete: real-time private messaging (`Conversation`/`Message` models, subscriber-only conversation creation gated by an `ACTIVE` subscription, live per-send subscription re-check with the model never gated, text + image/video attachments reusing the Session 04 `StorageClient`/`file-type` upload pattern, `@fastify/websocket` broadcast-only real-time delivery authenticated via the existing httpOnly cookie, 404-not-403 non-participant handling, cursor-paginated history, no-N+1 conversation list). 234 tests green. Migration `20260910120000_add_messaging` generated **and applied** — all 9 migrations now live on Supabase. Next: Session 08 (AI image personalization). Messaging fan-out is process-local — logged as an Open Item for horizontal scaling, not a blocker [2026-09-10]
