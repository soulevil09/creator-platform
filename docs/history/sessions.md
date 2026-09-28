Split out of CLAUDE.md in this commit (verbatim move; no content reworded).

# Session History


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

### Session 08 — AI Image Personalization ✅ Complete
**File:** `.claude/sessions/session-08.md`  
**Domain:** Likeness anchor engine, hidden system prompt, content-safety gate, preset + custom generation, credit deduction with automatic refund on provider failure

**Product decisions locked for this session:** generation is synchronous (blocks on the provider call, no job queue); a provider-side failure auto-refunds the debited credits in the same request; generated images are retained with a 30-day expiration (`GENERATION_IMAGE_RETENTION_DAYS`), not permanent and not one-time-view.

**Summary:**
- `GenerationMode` (`PRESET|CUSTOM`) / `GenerationStatus` (`PENDING|COMPLETED|FAILED`) enums + `GenerationJob` model added to Prisma; `User` gains `subscriberGenerations`/`modelGenerations` relations. Migration `20260911120000_add_generation_jobs` **generated and applied** to Supabase (10 migrations now live). `GenerationJob.modelId` is required and non-null — carried specifically so a future session can attribute credit-spend earnings to a model without a data migration (see Open Items).
- Hand-written partial unique index `GenerationJob_one_pending_per_subscriber` (`WHERE status = 'PENDING'`) enforces one in-flight generation per subscriber at the database level — the same "DB decides, not an app-level check" discipline as the Session 05 idempotency key and the Session 06 `payoutEmail` UNIQUE. The debit and the `PENDING` insert share a `$transaction`, so a rejected second insert rolls the debit back with it.
- **New module `modules/generation/`**:
  - `provider.interface.ts` — `IAIProvider.generateImage({ anchorPrompt, userPrompt, referenceImageUrls }) → { imageBuffer, providerJobId }`, normalized `AIProviderError`/`AIProviderConfigError`.
  - `adapters/replicate.adapter.ts` — `ReplicateAdapter`, pinned `tencentarc/photomaker` version hash. Creates a prediction, polls to completion within `GENERATION_TIMEOUT_MS` (default 90000ms), cancels and fails closed on timeout mid-poll. Error messages never quote a Replicate response body (Replicate echoes the input — our anchor — back in it).
  - `adapters/mock.adapter.ts` — `MockAIProvider`, deterministic fixed PNG, zero HTTP; `AI_PROVIDER=mock`.
  - `provider.factory.ts` — `getAIProvider()`/`assertAIProviderConfigured()`, mirrors the Session 05/06 payment/payout factories line for line; unknown `AI_PROVIDER` value crashes at boot.
  - `anchor.ts` — `buildAnchorPrompt(profile, referenceImageSignedUrls)`, pure/synchronous. Builds the hidden "identity lock" instruction from the model's display name + reference images; strips newlines from the model's own name before use (defends against injection even from the platform's own data). **Never** returned in any response, written to `GenerationJob.userPrompt`, or logged above debug — enforced by a dedicated non-leakage test (below).
  - `safety.ts` — `checkPromptSafety(prompt, { allowedNames })`, pure, **no configuration surface, no bypass for any role**. Two categories, `minor` taking precedence over `real_person` when both fire: age numerals + spelled-out ages (0–17, EN/PT-BR) plus a phrase list (school terms, age nouns, abuse vocabulary); and real-person signals (social handles, profile links, celebrity vocabulary, relationship targeting, resemblance/face-swap phrasing, Title-Case proper-name runs) with the model's own name exempted first. Runs **before** any credit debit or row write. `hashPrompt` (SHA-256) is what the audit log carries — never the plaintext prompt.
  - `presets.ts` — server-side scene-text fragments keyed by the shared catalog's preset ids; kept out of `@creator-platform/shared` on purpose so the browser only ever sees `id`/`label`/`creditsCost`, never text it could mistake for editable input.
  - `generation.schema.ts` / `generation.service.ts` / `generation.routes.ts` — Zod validation, business logic (credit debit → safety gate → provider call → store/refund), and the 5 REST endpoints below.
- `GET /api/generations/presets` — `authenticate` (any role), same posture as `GET /api/wallet/balance`.
- `POST /api/generations` — `authenticate` + `authorize('subscriber')`. Order of operations: 404 unknown model → **live** `ModelProfile.aiConsent` check (403 `ai_not_enabled`; a consenting model with zero `ReferenceImage`s is treated the same way, since text alone cannot anchor a likeness) → server-resolved cost → content-safety gate on `CUSTOM` prompts (400 `prompt_rejected`, zero side effects) → 429 if a `PENDING` job already exists → `walletService.debitCredits` (402 `insufficient_credits`) → create `PENDING` row → mint short-TTL signed reference-image URLs → build anchor → call the provider. On success: raw (unwatermarked) image stored via `StorageClient`, job → `COMPLETED` with `storageKey`/`expiresAt`; on failure/timeout: `walletService.addCredits` refund + job → `FAILED`, both in one transaction, `AuditLog` written, 502 `generation_failed`.
- `GET /api/generations` — caller's own jobs, cursor-paginated, no N+1; thumbnails only for `COMPLETED` jobs with `expiresAt` in the future.
- `GET /api/generations/:id` / `GET /api/generations/:id/image` — owner-only, **404 not 403** for a non-owner (same enumeration-resistance pattern as Session 06 payouts / Session 07 conversations), and 404 once `expiresAt` has passed even for the owner. The image endpoint watermarks **on-the-fly** at serve time reusing Session 04's `ImageProcessor.watermark` verbatim — never a pre-watermarked copy is stored. `storageKey` is never read into any response.
- Rate limit: 10 generations/hour/user, on top of the one-in-flight rule (bounds concurrency and total provider time independently).
- Shared: `GENERATION_MODES`, `GENERATION_STATUSES`, `GENERATION_PRESETS`, `GENERATION_CUSTOM_PROMPT_COST`, `GenerationPreset`, `findGenerationPreset`, `GenerationListItem`, `GenerationListResponse`, `GenerationDetailResponse`, `CreateGenerationRequest`/`Response`.
- **Anchor non-leakage test** — a single integration test drives every code path (preset success, custom success, prompt rejection, provider failure) then greps every response body, the serialized `GenerationJob` table, the serialized `AuditLog` table, and all three log levels (info/warn/error) for a distinctive anchor fragment (`"Identity lock:"`), asserting zero matches everywhere while also asserting the anchor really was built and really did reach the provider, and that the failure path did log something (proving the log spies are live, not just silent).
- 75 new tests (309 total, zero regressions); `pnpm turbo run typecheck lint test build` all green.

**Notes / deviations:**
- **Model choice: `tencentarc/photomaker`, not plain SDXL img2img** — img2img preserves composition, not identity; PhotoMaker conditions on stacked ID embeddings from the reference photos, which is what "prevents drift" actually requires. Version hash, input field names, and the polling contract are **provisional** — exercised only against `nock`-mocked HTTP, no live Replicate account yet. Re-verify against a live account before production, same as Woovi/NOWPayments/Paxum.
- **A consenting model with zero `ReferenceImage`s is rejected as `ai_not_enabled`, not a separate error** — not explicit in the original spec, but the smallest reading of "text alone cannot anchor a likeness": there is nothing honest to generate against, so it is treated as the same not-enabled condition, before any credit is touched.
- **Preset mode sends the preset's scene fragment as `userPrompt` to the provider, not an empty string** — the anchor is a pure likeness lock; the scene description has to come from somewhere, and the preset fragment is it. `GenerationJob.userPrompt` stores the human-readable preset label, as specified.
- **`GET /api/generations/presets` requires `authenticate`** — a logged-in purchasing surface, matching `/wallet/balance`'s posture; trivially reopened to anonymous later if wanted.
- **ARIA validation:** this session ships no frontend UI (same as Sessions 03/04/06/06.5/07). `eslint-plugin-jsx-a11y` still runs green over `**/*.tsx`.

**External Prerequisites:**
- [ ] Create Replicate account: https://replicate.com → sign up → go to https://replicate.com/account/api-tokens → generate token → copy `AI_PROVIDER_API_KEY`
- [ ] Review the `tencentarc/photomaker` model on Replicate and confirm the pinned version hash is current
- [ ] Add billing method on Replicate (pay-per-use): https://replicate.com/account/billing

---

### Session 09 — Anti-Leak & Content Protection ✅ Complete
**File:** `.claude/sessions/session-09.md`  
**Domain:** Per-viewer forensic watermarking (traceability), video trace via client overlay (Option B), client-side capture deterrents, storage hygiene sweep for orphaned objects

**Product decisions locked for this session:** the client-side layer is a **deterrent, not a security control** and is documented as such everywhere it appears; video keeps raw signed-URL delivery with a per-viewer trace overlay in the player (no ffmpeg); a leaked file is traced through the `AuditLog`, never by decoding anything in the file itself. Lei FELCA (age verification) is explicitly out of scope → Session 09.5.

**Summary:**
- **New module `modules/protection/`** — `trace.ts`: `computeTraceCode({ secret, entityId, viewerId, servedAt })` = `HMAC-SHA256(WATERMARK_TRACE_SECRET, entityId\nviewerId\nminute)` → first 5 bytes → **8 chars RFC 4648 base32** (exactly 40 bits; alphabet has no 0/O, 1/I ambiguity). Deterministic per (entity, viewer, minute): the same viewer refreshing within a minute gets one code, two viewers of the same item get different ones. `traceWatermarkLabel(code)` = `CreatorPlatform • <code>` is the **only** text that reaches the renderer. `createTraceRecorder({ prisma, secret })` mints the code and writes the lookup row — `AuditLog { actorId: viewerId, action: 'content.served' | 'generation.image_served', entity, entityId, metadata: { viewerId, traceCode, servedAt } }` — **awaited, one row per serve**. Both the content and generation modules call this one implementation; neither computes a code of its own.
- **D1 — images.** `GET /api/content/:contentId/serve` and `GET /api/generations/:id/image` now watermark with brand + trace code. **The requester's email is gone from the watermark** (Session 04 burned `brand • email`; a leaked file must not carry PII). `ImageProcessor.watermark(buffer, text, mimeType)` is **unchanged** — the trace is a policy concern composed into the label by the service, so the sharp-backed processor, its interface and every test fake stayed untouched.
- **D2 — video, Option B.** `GET /api/content/:contentId/serve` for `VIDEO` returns `{ signedUrl, expiresIn: 60, traceCode }` (`ContentVideoServeResponse` gains `traceCode`), same helper, same AuditLog row. The file behind the URL is **not** watermarked; the residual risk (direct fetch within the 60 s TTL yields the unmarked original) is documented in `content.service.ts`, the shared type, the component and the Architecture Decisions below.
- **D3 — `apps/web/src/components/ProtectedMedia.tsx`.** Wrapper (`role="group"`) that prevents `contextmenu` and `dragstart`, sets `user-select: none` / `draggable={false}`, blurs its content (`filter: blur(24px)`) and pauses any *playing* `<video>` on `document.visibilitychange → hidden` or `window.blur`, and restores (resuming only what it paused) on return; renders `traceCode` as a persistent `aria-hidden` low-opacity overlay with `pointer-events: none`; announces the obscured state through a `role="status"` live region. File header + JSDoc state plainly that these are deterrents and cannot stop an OS screenshot, a recorder or a camera. Demo route `apps/web/src/app/dev/protected-media/page.tsx` — inline-SVG placeholder image + source-less placeholder `<video muted>`, fixed fake codes, **`notFound()` in production**; never points at the real API. **7 component tests** (`ProtectedMedia.test.tsx`) — the web package's first suite (`apps/web/vitest.config.ts`: jsdom + `esbuild.jsx: 'automatic'`, no Vite React plugin taken).
- **D4 — `POST /api/admin/storage/cleanup/run`** (`modules/storage-cleanup/`). Guarded by `X-Storage-Cleanup-Cron-Secret` vs `STORAGE_CLEANUP_CRON_SECRET` with the same local `secretMatches` (`crypto.timingSafeEqual`, length-checked) as the payout/renewal runs, rejected 401 before any DB/storage access, 4/hour. Sweeps `Content` rows with `deletedAt IS NOT NULL AND storageKey IS NOT NULL` and `GenerationJob` rows with `status = COMPLETED AND expiresAt <= now AND storageKey IS NOT NULL`, in **id-ordered keyset pages of 100** (`CLEANUP_BATCH_SIZE`), `select: { id, storageKey }` only. Per row: `StorageClient.deleteFile` → compare-and-set `updateMany({ where: { id, storageKey: <the key just deleted> }, data: { storageKey: null } })`. Delete-then-null, so a crash between the two is healed by the next run (S3 DeleteObject on a missing key is a no-op); the CAS makes an overlapping run count the row as `skipped`, never twice as `deleted`. A provider error counts `failed` and leaves the key for tomorrow. Response and summary `AuditLog` row (`storage.cleanup_run_completed`) carry **counts only** (`{ deleted, skipped, failed }`; the audit metadata adds up to 50 failed row *ids*, never a key). Migration **`20260912120000_nullable_content_storage_key`** (`Content.storageKey` → nullable) **generated and applied** — 11 migrations live. `.github/workflows/storage-cleanup.yml` — daily 07:00 UTC (one hour after the renewal sweep), `workflow_dispatch`, `concurrency` guard, secret read from the environment.
- `env.ts`: `WATERMARK_TRACE_SECRET` via new `requiredMinLength(name, 32)` — required in **every** environment like `JWT_SECRET`, plus a length floor because the whole value is HMAC entropy; `STORAGE_CLEANUP_CRON_SECRET` via `requiredInProduction`. Both in `vitest.setup.ts` and both `.env.example` files.
- Shared: `ContentVideoServeResponse.traceCode`, `StorageCleanupRunSummary`.
- Test infra: `test/fake-prisma.ts` gained `content.update/updateMany`, keyset/cursor pagination shared between `content.findMany` and `generationJob.findMany` (`paginate`), and a generic `rowMatches` with `lt/lte/gt/gte` on dates and strings; `FakeContent.storageKey` is now nullable + `viewCount`. The content suite's local fake gained `auditLog.create`.
- **22 new API tests** (331 total, zero regressions) + **7 web tests**; `pnpm turbo run typecheck lint test build` and root `pnpm lint` (incl. jsx-a11y) all green.

**Notes / deviations:**
- **`ImageProcessor` interface unchanged (no `watermarkWithTrace`).** The spec left this to the implementer. The processor is a rendering primitive that knows nothing about viewers; "what text goes on the image" is a service decision (it already was — the service used to build `brand • email`). Composing the label in the service kept the sharp implementation, the interface and all fakes untouched and still satisfies "renders the code alongside current branding".
- **`secretMatches` is duplicated locally a third time**, exactly as `payouts.routes.ts` and `subscriptions.routes.ts` each carry their own. Extracting a shared helper would have meant editing two prior-session files for a six-line function; the pattern in this codebase is one local copy per cron route, and the spec said to mirror it exactly.
- **Keyset (`id > cursor`) rather than Prisma `cursor: { id }`, skip 1.** The pattern is the same opaque last-id cursor `GET /api/generations` threads as `nextCursor`; the predicate form differs because the cursor row has *just left the filtered set* (its key was nulled) and a keyset predicate says "everything after it" with no dependence on how the engine positions a cursor that no longer matches the `where`.
- **`Content.storageKey` became nullable** (one migration, one `DROP NOT NULL`). This is what makes "storageKey never exposed" true at rest and a re-run a fast no-op — the spec's "consider nulling" was taken. `serve` treats a null key as 404 (a purged row is already a tombstone); the list endpoint's `deletedAt: null` filter never sees one.
- **The demo route 404s in production.** Not in the spec text, but "dev-only page" plus "must not be reachable with real signed URLs" made hiding it from the deployed app the smaller reading.
- **The subscriber's email was removed from the image watermark.** Required by D1's non-leakage constraint; the two Session 04/08 tests that asserted the email in the label were updated to assert the brand + code shape and the absence of the email/id instead.
- **ARIA validation:** `eslint-plugin-jsx-a11y` caught one real finding on the new demo page (`img-redundant-alt`), fixed; zero remaining. The component uses `role="group"` + `aria-label`, an `aria-hidden` decorative overlay and a `role="status"` live region.

**External Prerequisites:**
- [x] No new external accounts required
- [x] Storage provider supports signed URLs + `DeleteObject` (Supabase Storage S3 endpoint — already in use)
- [ ] Generate `WATERMARK_TRACE_SECRET` (`openssl rand -hex 32`, ≥ 32 chars) for every deployed environment — **the API will not boot without it**
- [ ] Generate `STORAGE_CLEANUP_CRON_SECRET` (`openssl rand -hex 32`) and store it as a GitHub Actions repository secret (alongside the existing `API_PUBLIC_URL`)

---

### Session 09.5 — Lei FELCA: Age Verification (CPF + Face ID) ⏳ Pending — **DEFERRED**
**File:** `.claude/sessions/session-09.5.md` _(to be written)_  
**Domain:** Lei 15.211/2025 compliance — CPF + facial age verification for subscribers before any 18+ content is served; KYC vendor abstraction (`IAgeVerificationProvider`), verification status on `User`, gate in `resolveAccess`/serve paths, ANPD-grade audit trail.

**Deliberately deferred [2026-09-14]** — business decision to prioritize time-to-MVP over closing this gap immediately. Accepted risk while deferred: full ANPD enforcement with fines starts January 2027 (not immediately), and the definitive technical guide was still mid-public-consultation as of Sept 2026 — but the platform runs non-compliant with the self-declaration ban in the interim. **Must ship before meaningful Brazilian subscriber volume.**

**External Prerequisites (when resumed):**
- [ ] Confirm CAF/Certta's enterprise-tier biometric face-match pricing — the self-service "Certta Start" plan (R$200–600/mo, R$1.50–2.50/consulta) covers CPF/document/background checks only; CPF alone is explicitly equated to self-declaration in ANPD's draft guide, so it does NOT satisfy the law on its own
- [ ] Confirm CAF/Certta (or alternative: idwall, unico, Serpro Datavalid direct — the last requires SENATRAN/Credencia accreditation + a GCC intermediary, heavier onboarding) accepts adult-content platforms as a client
- [ ] Vendor API credentials + webhook secret

---

### Session 10 — i18n & Multilingual ✅ Complete
**File:** `.claude/sessions/session-10.md`  
**Domain:** PT-BR + EN, i18n framework, all strings externalized

**Summary:**
- **Frontend — `next-intl` v4.** Per-request `getRequestConfig` (`apps/web/src/i18n/request.ts`) resolves the locale server-side before any component renders — cookie (`NEXT_LOCALE`) → `Accept-Language` → `NEXT_PUBLIC_DEFAULT_LOCALE` — so the first HTML byte is already in the right language, no client-side flash of the wrong locale (proven against a **real** `next build`/`next start` server, not a mock). Message catalogs `apps/web/messages/{en,pt-BR}.json`; only the active locale's catalog ships to the client via `NextIntlClientProvider`. Routing is **cookie-only, no `/en/` prefix** — every existing route stays unprefixed; justified in Architecture Decisions below.
- Every literal string in `layout.tsx` (incl. `generateMetadata`), `page.tsx`, `wallet/page.tsx`, `ProtectedMedia.tsx` (default `aria-label` + `role="status"` live region) and the `/dev/protected-media` demo now reads from the catalog. `LocaleSwitcher.tsx` — client component, writes the `NEXT_LOCALE` cookie + `router.refresh()`, takes effect on the next navigation with no restart.
- `User.preferredLocale String @default("pt-BR")` added to Prisma; migration `20260920120000_add_user_preferred_locale` **generated and applied** (12 migrations now live). Allowlisted by Zod (`'pt-BR' | 'en'`) at every write path — a plain `String` column, not a DB enum, so a third language later is a code change only.
- `POST /api/auth/register` accepts an optional `locale` (lenient — an invalid value falls through to `Accept-Language`, then default, and never blocks signup). New `PATCH /api/auth/me/locale` — `authenticate`, strict `z.enum` (400 on anything off the allowlist), rate-limited like the project's other authenticated write endpoints. `GET /api/auth/me` now echoes `preferredLocale`.
- `Emailer.sendVerificationEmail` / `sendRenewalReminderEmail` gain a `locale` parameter; both templates exist in full PT-BR and EN as a plain `Record<Locale, template>` map in `email.ts` — no i18n runtime dependency on the API, mirroring the `CHANNEL_CURRENCY` keyed-map pattern. `formatAmount` rebuilt on `Intl.NumberFormat` (`R$ 29,90` vs `$29.99` for the same cents); dates through `Intl.DateTimeFormat`. `escapeHtml` still guards every interpolated value in both locales.
- `SUBSCRIPTION_PLANS` / `CREDIT_PACKS` / `GENERATION_PRESETS` labels are now `LocalizedLabel = Record<Locale, string>` (key parity enforced by the type itself), resolved via `resolveLabel(label, locale)` — a pure in-memory lookup, no new DB/network call on any hot path. `GenerationJob.userPrompt` and the Woovi/NOWPayments charge `description` deliberately keep storing the **canonical English** label (`CANONICAL_LABEL_LOCALE`) rather than the viewer's language — see Notes below.
- `negotiateLocale` (RFC 9110 `Accept-Language` parsing, q-weights honoured) lives in `@creator-platform/shared` so the API and the web app share one parser; every entry point re-validates its output with the same Zod allowlist before use. Catalog imports are literal per-locale entries in a `Record`, never a path built from request input.
- 349 API tests (+18: 7 auth, 9 email, 2 subscriptions), 33 web tests (+26, incl. 5 real-server SSR tests), 6 new shared tests; zero regressions. `pnpm turbo run typecheck lint test build` and root `pnpm lint` (incl. jsx-a11y) all green.

**Notes / deviations:**
- **`userPrompt` and the payment-provider charge description stay in canonical English, not the viewer's locale.** `GenerationJob.userPrompt` is a record of what was requested (`presetId` is stored alongside for display-time resolution) — storing English keeps pre/post-Session-10 rows byte-identical and avoids freezing a language into a persisted request. The Woovi/NOWPayments `description` string is provider-facing, not subscriber-facing, so localizing it would be new payment behavior — out of this session's scope.
- **Cookie-only locale routing, no path prefix.** Every existing route (`/`, `/wallet`, `/dev/protected-media`) is unprefixed and the API already emits absolute links into them (`/verify-email?token=…`, `/subscriptions`); the platform is auth-gated end to end, so per-language URLs buy no SEO benefit here.
- **`GET /me` now returns `preferredLocale`** — not explicit in the spec, but without it the value `PATCH /me/locale` writes would be unreadable by any client.
- **Wallet prices now follow the UI locale** (`R$19.90` when the switcher is set to `en`) rather than being currency-driven (`pt-BR` for BRL regardless of UI language) — a direct consequence of removing the page's hardcoded `Intl.NumberFormat('pt-BR' | 'en-US', …)` branch in favor of the resolved locale.
- **`zod` added to `apps/web`** (server-only usage in `src/i18n/locale.ts`, never bundled to the browser) so the web app's cookie/header/env allowlist reuses the same Zod-enum pattern as the API instead of a second validation approach.
- Two pre-Session-10 assertions updated with the label-shape change, values unchanged: `generation.test.ts` (`PRESET.label` → `PRESET.label.en`) and `auth.test.ts` (`/me` now includes `preferredLocale`).
- **ARIA validation:** `eslint-plugin-jsx-a11y` green, zero findings. `ProtectedMedia`'s default label and live-region text are asserted against the real catalog in both locales.

**External Prerequisites:**
- [x] No new external accounts required
- [x] Migration `20260920120000_add_user_preferred_locale` applied — the Supabase project had paused between generation and apply (same recurring issue as Session 07); resolved by restoring the project in the dashboard and re-running `prisma migrate deploy`

---

### Session 11 — Admin Dashboard ✅ Complete
**File:** `.claude/sessions/session-11.md`  
**Domain:** Metrics, user management, model approval, payout oversight, moderation — all behind the existing `authenticate` + `authorize('admin')` RBAC, every state change audited.

**Summary:**
- `ModelApprovalStatus` enum (`PENDING|APPROVED|REJECTED`) + `ModelProfile.approvalStatus @default(PENDING)` / `approvalReviewedAt` / `approvalRejectionReason`; `User.suspendedAt DateTime?`; `Report` model (`ReportReason` `SPAM|ILLEGAL|NON_CONSENSUAL|OTHER`, `ReportStatus` `PENDING|RESOLVED|DISMISSED`, `resolvedAction`, `resolvedAt`, index on `(status, createdAt)`) with a hand-written partial unique index `Report_one_pending_per_reporter_content` (`WHERE status = 'PENDING'`) — same "the database decides" pattern as `GenerationJob_one_pending_per_subscriber`. One migration `20260920180000_add_admin_dashboard` **generated (offline, `prisma migrate diff`) and applied** — 13 migrations live.
- **New module `modules/admin/`** (`admin.routes.ts` / `.service.ts` / `.schema.ts` / `.test.ts`). `authenticate` + `authorize('admin')` are added as **plugin-scoped `preHandler` hooks**, so no route in the plugin can be registered without them. Rate limits are route-level `app.rateLimit()` preHandlers (run after the auth hooks) so they genuinely key on the admin's userId — see Notes.
- **D1 — model approval.** `GET /api/admin/models?status=pending|approved|rejected|all` (default `pending`, paginated ≤100, oldest first) returns each profile + fresh 300 s signed URLs for its reference images (same TTL as `GET /onboarding/profile`; `storageKey` never serialized). `POST /api/admin/models/:userId/approve` — works from any prior status, clears the rejection reason, audits `model.approved` with the previous status; idempotent (200 `changed: false`, no second audit row). `POST /api/admin/models/:userId/reject` — body `{ reason }` required (400 otherwise), audits `model.rejected` with the reason. 404 `model_not_found` for an unknown/non-model id, 404 `model_profile_not_found` for a model with no profile yet. **Content upload (`content.service.upload`) and subscription checkout (`payments.service.issueSubscriptionCharge`) now additionally require `approvalStatus === 'APPROVED'`** → 403 `{ error: 'model_not_approved' }` (same `{ error }` shape as the existing verified/profile gates, machine code so a UI can distinguish it). Because the renewal sweep goes through `issueSubscriptionCharge`, a model rejected after acquiring subscribers stops being re-charged for (the sweep already audits `subscription.renewal_charge_failed`).
- **D2 — user management.** `GET /api/admin/users` (paginated, `role=` filter, case-insensitive `email=` substring; Prisma `select` keeps `passwordHash`/`refreshTokenHash` out of the query itself, not just the mapper) and `GET /api/admin/users/:userId` (list row + `model: { approvalStatus, …, payoutEmailConfigured }` for MODEL, `subscriber: { activeSubscriptions, walletBalance }` for SUBSCRIBER). `POST /api/admin/users/:userId/suspend` (optional `reason`) / `/reinstate` — audited `user.suspended` / `user.reinstated`, idempotent, **403 `cannot_suspend_admin` before any write or audit row when the target is an ADMIN** (including yourself). `auth.service.validateCredentials` and `assertRefreshTokenValid` both throw 403 `account_suspended` when `suspendedAt` is set — login and refresh are the two places a session is minted, and the check lives nowhere else.
- **D3 — `GET /api/admin/metrics/overview`.** Exactly **7 aggregate queries** whatever the row counts (asserted by a `__calls` query-count test with 60 models/120 subscriptions seeded): `subscription.groupBy(subscriberId)` (distinct active subscribers), `subscription.groupBy(tier, provider)` (actives by tier + estimated recurring revenue), `paymentTransaction.groupBy(currency)` (confirmed CREDIT_PACK in the last 30 days), `generationJob.groupBy(status)` (last 30 days + completion rate), `payout.groupBy(status, currency)` (PENDING/PROCESSING/COMPLETED totals), the payout run's own `paymentTransaction.groupBy(modelId)` + one `modelProfile.count` (models above threshold with no `payoutEmail` — the rows the next run will skip). **Every money figure is an array of `{ currency, amountCents }`; nothing is summed across currencies.**
- **D4 — payout oversight.** `payoutsService.runPayouts` now takes a `PayoutRunTrigger` (`{ source: 'cron' } | { source: 'admin', actorId }`); the existing cron-secret `POST /api/payouts/run` and the new `POST /api/admin/payouts/run` (admin JWT, 2/hour per admin) call the **same function**, and the `payout.run_completed` audit row records `triggeredBy` + `actorId`. A test runs an identical ledger through both entrances and asserts identical `Payout`/`PaymentTransaction`/audit footprints; a non-admin gets 403 with zero rows touched. `GET /api/payouts` + `/:payoutId` (Session 06) are consumed as-is by the dashboard — nothing duplicated.
- **D5 — content moderation.** `POST /api/content/:contentId/report` — any authenticated user, `{ reason, details? }`, 201 on a new report / **200 with the same row** while one from that caller is still PENDING (P2002 from the partial index → no-op), 404 for unknown/deleted content, 10/hour **per user** (post-auth preHandler). `PATCH /api/content/:contentId/publish` now accepts `admin` (`authorize('model', 'admin')`) with the ownership check bypassed for admins inside `setPublish` — the moderation unpublish lever. `GET /api/admin/reports?status=` (paginated, joins reporter + content + content owner incl. `suspendedAt`). `POST /api/admin/reports/:reportId/resolve` `{ action: 'none' | 'unpublish' | 'unpublish_and_suspend_model' }` — `unpublish` calls the injected `contentService.setPublish(adminId, contentId, false, 'admin')` (pinned by a unit test on the seam), `unpublish_and_suspend_model` additionally calls the D2 `suspendUser` path; the report is then claimed with a compare-and-set on `status = PENDING` (409 `report_already_resolved` on a replay) and `report.resolved` is audited with action + reportId + contentId.
- **D6 — `apps/web/src/app/admin/`** (layout + `/`, `/models`, `/users`, `/payouts`, `/reports`), the first admin-facing pages in the app. `AdminGate` (client) asks `GET /api/auth/me` and `router.replace('/')`s anyone who is not an admin — a convenience only; the server-side `authorize('admin')` is the boundary. **Every state-changing action goes through one `ConfirmAction` component**: the first click only reveals a `role="group"` confirmation panel (focus moves into it), `onConfirm` fires only from the Confirm button inside, and a required reason keeps Confirm disabled until typed. All strings live in the `admin` namespace of both catalogs (parity enforced by the Session 10 test); free text (rejection reasons, report details) is rendered as React text nodes — never `dangerouslySetInnerHTML`. No new dependency: tables and pagination are hand-rolled (an offset `Pager` over the API's `{ total, limit, offset }` envelope is ~30 lines; a table library would buy sorting/virtualisation this console does not need).
- Shared: `MODEL_APPROVAL_STATUSES`, `REPORT_REASONS`, `REPORT_STATUSES`, `REPORT_RESOLVE_ACTIONS`, `ADMIN_MODEL_STATUS_FILTERS`, `ADMIN_REPORT_STATUS_FILTERS`, `ADMIN_METRICS_WINDOW_DAYS`, `AdminPage<T>`, `AdminUserListItem`/`AdminUserDetail`, `AdminModelListItem`/`AdminModelDecisionResponse`, `AdminSuspendResponse`, `AdminMetricsOverview`, `ReportContentRequest`/`Response`, `AdminReportListItem`, `AdminResolveReportRequest`/`Response`, `PayoutRunTrigger`.
- Test infra: `test/fake-prisma.ts` gained a generic `groupBy` (`by` any columns, `_count`, `_sum` with Postgres null semantics — the payout run's shape is now a special case of it), `user.findMany/count`, `modelProfile.findMany/count` (with `user` + `referenceImages` includes), `subscription.count/groupBy`, `payout.groupBy`, `generationJob.groupBy`, `content.create`, the `report` delegate (partial-unique enforced), `contains`/`mode: 'insensitive'` in `rowMatches`, `FakeUser.suspendedAt`, and approval fields on `FakeProfile` (`seedProfile` defaults to `APPROVED` so every pre-Session-11 fixture still monetizes). The content suite's local fake seeds `approvalStatus: 'APPROVED'` too.
- **25 new API tests (374 total), 6 new web tests (39 total), zero regressions**; `pnpm turbo run typecheck lint test build` and root `pnpm lint` (incl. jsx-a11y, zero findings on the new pages) all green.

**Notes / deviations (smallest reasonable choices, flagged):**
- **"Subscription/credit checkout" gate → subscription checkout only.** Credit-pack checkout has no model in it (credits are a wallet-wide balance), so there is nothing to gate on approval; the approval check sits in `issueSubscriptionCharge` (the single subscription-charge seam) and returns the same 403 `model_not_approved` as the upload gate, not the 409 the "no profile yet" case uses.
- **Estimated recurring revenue is bucketed by `Subscription.provider` → settlement currency** (`WOOVI → BRL`, `NOWPAYMENTS → USD`, derived from `CHANNEL_CURRENCY`). `Subscription` carries no currency column and Prisma `groupBy` cannot join to the confirming transaction, so the adapter — which for both real adapters bills in exactly one currency — is the only aggregate-safe source. Subscriptions on the offline mock (`CCBILL_MOCK`, whose currency is not inferable from the row) are reported as `unattributedSubscriptions`, never guessed into a bucket.
- **`Report.status = DISMISSED` exists in the enum but no endpoint sets it.** The spec's resolve endpoint "sets `status: RESOLVED`" for every action including `none`, and that is what ships; mapping `none → DISMISSED` would have been an interpretation. The listing filter accepts `dismissed` so a future endpoint needs no API change.
- **`suspendedAt` is included in the users list row** (the spec's field list omits it) — the users table cannot offer suspend vs. reinstate without it.
- **Rate limits on the new routes are `app.rateLimit()` preHandlers, not `config.rateLimit`.** While wiring the admin routes it became clear that `config.rateLimit` runs at `onRequest`, before `authenticate`, so the `keyGenerator: request.user?.userId ?? request.ip` pattern the codebase uses on its authenticated write endpoints (checkout, cancel/resume, `/me/locale`, …) silently keys on IP. The new routes use the route-level preHandler form, which runs after the plugin-scoped auth hooks; the pre-existing routes were **not** changed (out of scope) — **fixed in Session 11.5** (see its entry below).
- **Approve clears `approvalRejectionReason`** (the previous reason is preserved in the `model.approved` audit metadata); re-rejecting with the identical reason is a no-op, a different reason is a new audited decision.
- **`resolveReport` runs the (idempotent) side effects first, then claims the report** with `updateMany({ where: { id, status: 'PENDING' } })`. Two admins resolving at once both unpublish (a no-op the second time) and exactly one gets RESOLVED + an audit row; the other gets 409. Content soft-deleted since the report was filed is treated as "nothing left to unpublish", not a failure.
- **Migration note:** `prisma migrate status` showed Session 10's `20260920120000_add_user_preferred_locale` as **not yet applied** despite the Session 10 write-up; `migrate deploy` applied it together with this session's migration. Both are live now.
- The four Open Items the spec names as "candidate: Session 11" (FX-aware payout balances, crediting credit-pack spend to models, a `Payout`/renewal reconciliation sweeper, stale `PENDING GenerationJob` cleanup) were **deliberately not implemented** — they remain open below, now pointed at Session 12.
- **ARIA validation:** `eslint-plugin-jsx-a11y` zero findings on the six new admin `.tsx` files. Confirmation panels are `role="group"` labelled by their prompt; every input/select has a `<label>`; tables use `scope="col"`; async state is announced through `role="status"` live regions; reference images carry descriptive `alt`.

**External Prerequisites:**
- [x] No new external accounts required
- [ ] (Optional) Analytics: https://posthog.com → create account (free tier) → copy project API key — not taken this session

---

### Session 11.5 — Hotfix: Per-User Rate Limits Were Silently Keying on IP ✅ Complete
**File:** `.claude/sessions/session-11.5.md`  
**Domain:** Re-wire five pre-existing per-user rate limits from `config.rateLimit` (an `onRequest` hook, runs before `authenticate`) to `app.rateLimit()` as a post-`authenticate` `preHandler` — the pattern Session 11 introduced. Key fix only; no budget value changed.

**Summary:**
- **D1 `auth.routes.ts`** — `AUTHENTICATED_WRITE_RATE_LIMIT` (20/hour) on `PATCH /api/auth/me/locale`: `preHandler: [authenticate, app.rateLimit(…)]`.
- **D2 `payments.routes.ts`** — `CHECKOUT_RATE_LIMIT` (10/min) on `POST /checkout/subscription` and `/checkout/credits`: `preHandler: [...subscriberOnly.preHandler, app.rateLimit(…)]`.
- **D3 `messaging.routes.ts`** — `SEND_RATE_LIMIT` (60/min: create conversation, send message, mark read) and `READ_RATE_LIMIT` (120/min: list conversations, history, attachment URL) on all six registrations.
- **D4 `generation.routes.ts`** — `CREATE_RATE_LIMIT` (10/hour) on `POST /api/generations`.
- **D5 `subscriptions.routes.ts`** — `WRITE_RATE_LIMIT` (20/hour) on `POST /model/:modelId/cancel` and `/resume`. `READ_RATE_LIMIT` (`GET /me`) untouched.
- Each const's doc comment now records why it is attached after `authenticate`.
- **7 new tests** (one per const; checkout covers both endpoints via `it.each`), each in the three-part shape: exhaust the budget as one account → 429; the **same account from a different IP** (`app.inject({ remoteAddress: '10.0.0.2' })`) → still 429; a **second account from the same IP** → allowed. A mutation check put the five route files back to the old wiring and all 7 new tests fail there (the different-IP call got a fresh budget), then pass again with the fix, so they really detect this bug.
- Full API suite run after each file change (375 → 377 → 379 → 380 → 381), green every time. Every targeted route kept an active limit at every step, since each attachment was swapped in a single edit. **381 API tests (+7)**, 39 web, 6 shared, zero regressions; `pnpm turbo run typecheck lint test build` and root `pnpm lint` green.

**Notes / deviations:**
- **No shared `withUserRateLimit` helper.** The fix is one array literal per route, identical in shape to Session 11's `admin.routes.ts` / content report route. A helper would have added a sixth file and a second spelling of the same pattern for no reduction in risk; the per-const doc comments carry the "why".
- **On subscriber-only routes the limiter sits after `authorize('subscriber')` too**, not just after `authenticate` (`[authenticate, authorize('subscriber'), app.rateLimit(…)]`). A wrong-role caller gets its 403 without using up budget, the same ordering the admin plugin uses (plugin-scoped auth + role hooks, then the route-level limiter). The limiter is still keyed on the same userId.
- **Out of scope, verified unaffected:** register/login (IP is the only key before a user exists), webhooks and cron runs, `content.routes.ts` upload, `onboarding.routes.ts`, `wallet.routes.ts`, `payouts.routes.ts` (including `PUT /payout-email`, which the Session 11 Open Item listed but which never declared a per-user `keyGenerator`), and subscriptions `GET /me`. All of these are IP-scoped by design and remain so.

**External Prerequisites:**
- [x] None

---

### Session 12 — Security Hardening & Performance Audit ✅ Complete
**File:** `.claude/sessions/session-12.md`  
**Domain:** CI gate + dependency audit, client IP behind a proxy, request-size limits, API/web security headers, error surface, test-enforced route inventory, login timing + JWT algorithm hardening, written OWASP audit, query-driven index review, reconciliation sweep, load-test baseline.

**Summary:**
- **D0 — CI gate.** `pnpm install --frozen-lockfile` verified clean before any change. `.github/workflows/ci.yml` gains `build` (`pnpm turbo run build`) and `audit` (`pnpm audit --prod --audit-level=high`) jobs — five jobs now. High/critical advisories fixed by in-range upgrades: `sharp` 0.35.5, and transitive `fast-uri` 3.1.8, `find-my-way` 9.9.0, `nanoid` 3.3.19. The 12 left are all in `next@14.2.35` (latest 14.x) or the `postcss@8.4.31` it pins exactly — fixes exist only in Next 15 (a major bump) — and each is excepted **by its own id** in root `package.json` `pnpm.auditConfig` (8 via `ignoreCves`, 4 GHSA-only advisories via `ignoreGhsas`), listed with reasons in `docs/security/owasp-audit.md` (A06). The audit exits 0.
- **D1 — client IP + body size.** `TRUST_PROXY` parsed by `parseTrustProxy` (`src/lib/env.ts`) to `false` (default) / hop count / IP-CIDR list and passed to `Fastify({ trustProxy })`; **`true` is rejected at boot**. Global `bodyLimit` 1 MB (multipart keeps its per-route `fileSize` limits; webhooks unaffected). Tests: with `TRUST_PROXY=1` an `X-Forwarded-For: 203.0.113.7` request resolves `request.ip` to that address and the login limit counts against it; unset, the header is ignored and a spoofed address cannot reset the login budget; a >1 MB JSON body is 413 `payload_too_large`.
- **D2 — headers + error surface.** `@fastify/helmet`: CSP `default-src 'none'; frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, CORP `same-site`, `X-Frame-Options: DENY`, HSTS (1 y, includeSubDomains) only when `env.isProduction` (overridable via `buildServer({ hsts })` for tests). The watermarked image streams keep `Cache-Control: no-store`; CORP `same-site` did not need a per-route exception (web and API share a site; test asserts the web origin gets the bytes). `src/security/error-handler.ts`: 5xx/no-status → 500 `{ error: 'internal_error' }` with the full error to `request.log.error`; parse/validation → 400 `bad_request`; oversize → 413 `payload_too_large`; unknown route → 404 `not_found`; every other 4xx (e.g. 429) keeps Fastify's default body, unchanged. The two raw-body webhook parsers now raise Fastify's `FST_ERR_CTP_INVALID_JSON_BODY` rather than a `SyntaxError` quoting the body.
- **D3 — route inventory.** `src/security/route-inventory.ts` records every route at boot (`onRoute` + one `onReady` resolution, nothing per request): method, URL, whether `authenticate` runs (route-level `onRequest`/`preValidation`/`preHandler` or a plugin-scoped hook) and whether a limit applies (`config.rateLimit`, or a handler minted by `app.rateLimit()`, recognised by wrapping that decorator). `src/security/route-policy.ts` holds `PUBLIC_ROUTES` (13 entries: `/health`, register/verify-email/login/refresh, the public catalogue, 3 webhooks, 4 cron runs) and `UNLIMITED_ROUTES` (`/health` only), each with a reason. `route-inventory.test.ts` fails naming `METHOD /url` for any route outside policy, and for any stale allowlist entry. **Mutation check:** removing `authenticate` from `GET /api/wallet/balance` fails the test with "unauthenticated and not in PUBLIC_ROUTES: GET /api/wallet/balance"; restored.
- **D3 gaps fixed (15 routes had no rate limit; no auth gaps).** Per user, after auth (`app.rateLimit()` in `preHandler`/`preValidation`): `GET /api/auth/me` 120/min, `POST /api/auth/logout` 20/h, `GET /api/onboarding/profile` 60/min, `DELETE /api/onboarding/reference-images/:imageId` 20/h, `PATCH /api/content/:contentId/publish` 60/min, `DELETE /api/content/:contentId` 60/min, `GET /api/content/:contentId/serve` 120/min, `GET /api/generations/presets`, `GET /api/generations`, `GET /api/generations/:id`, `GET /api/generations/:id/image` 120/min each, `GET /ws/messages` upgrades 30/min. Per IP (`config.rateLimit`, no user yet): `GET /api/auth/verify-email` 30/h, `POST /api/auth/refresh` 60/15 min, `GET /api/content/model/:modelId` 120/min. No existing limit value changed.
- **D4 — auth hardening.** `validateCredentials` runs one cost-12 `bcrypt.compare` against `DUMMY_PASSWORD_HASH` (random plaintext, hashed once at module load) on the unknown-email path; order and bodies unchanged. Both JWT namespaces pin `sign: { algorithm: 'HS256' }` + `verify: { algorithms: ['HS256'] }`. Tests: spied `bcrypt.compare` called exactly once on each 401 path (against a cost-12 hash); an HS512/HS384 token with the same secret is 401 on `GET /api/auth/me` while the identical HS256 token is 200 (a mutation removing the pin fails it). Register's 409 unchanged — accepted risk in the audit.
- **D5 — web headers + audit.** `apps/web/src/middleware.ts` (renamed to proxy in Session 12.6 — now `src/proxy.ts`) mints a 128-bit nonce per document request and sets the CSP (built by `src/security/csp.ts`) on the forwarded request and the response: `script-src 'self' 'nonce-…' 'strict-dynamic'` (+ `'unsafe-eval'` in development only), `connect-src 'self'` + API origin + its `ws(s):` twin, `img-src`/`media-src 'self' data: blob:` + API origin + `NEXT_PUBLIC_MEDIA_ORIGIN`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. Static headers (`nosniff`, `strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options: DENY`, HSTS in production) in `next.config.mjs` `headers()`. Locale resolution untouched. The real-server SSR test now asserts the production response carries a nonce CSP, every `<script>` carries that nonce, the nonce differs per request, and the static headers (HSTS included) are present. `docs/security/owasp-audit.md` covers A01–A10.
- **D6 — reconciliation.** New `modules/reconciliation/` + `POST /api/admin/reconciliation/run` (`X-Reconciliation-Cron-Secret`, local `secretMatches` with `timingSafeEqual`, 401 before any DB access, 4/hour) + `.github/workflows/reconciliation.yml` (daily 07:30 UTC, `workflow_dispatch`, concurrency guard). Pass 1: `PENDING` jobs older than `GENERATION_STALE_AFTER_MS` → one `$transaction` with a CAS to `FAILED` (`errorMessage: 'reconciled_stale'`), `walletService.addCredits` of the **stored** `creditsCost`, and a `generation.reconciled_stale` audit row (`jobId`, `creditsRefunded`, no prompt) — which frees the one-in-flight slot. Pass 2: `PENDING`/`PROCESSING` payouts older than `PAYOUT_STALE_AFTER_HOURS` → no status change, one `payout.stale_detected` row per payout per UTC day, made idempotent by a deterministic audit-row id (`payout_stale_<id>_<YYYY-MM-DD>`) so the primary key rejects a second flag. Keyset pages of 100. Response + `reconciliation.run_completed` row carry `{ generationsReconciled, generationsSkipped, stalePayoutsFlagged }` only. `GET /api/admin/metrics/overview` gains `payouts.stalePayouts` (one added `payout.count`; the query-count test was updated by exactly that query).
- **D7 — index review.** `docs/performance/index-review.md` maps 27 hot query paths to the index serving each (or "none" with the reason). Migration `20260927120000_security_index_review` (**generated offline with `prisma migrate diff` + hand-written SQL, and applied** — 14 migrations live): adds `AuditLog_traceCode_idx` (expression `(metadata->>'traceCode')`, partial on the two serve actions), `ReferenceImage_modelProfileId_idx` (unindexed FK on the generation hot path), partial `GenerationJob_cleanup_expiresAt_idx` and partial `Content_cleanup_pending_idx` (the two cleanup sweeps); drops `ContentAccess_contentId_idx` (pure duplicate of the leading column of `ContentAccess_contentId_userId_key`).
- **D8 — load baseline.** `apps/api/scripts/load/run.ts` (`pnpm --filter @creator-platform/api load [--dry-run]`): boots `buildServer` in-process with every provider on `mock`, refuses on `NODE_ENV=production` or a `DATABASE_URL` host in `LOAD_TEST_FORBIDDEN_HOSTS`, seeds uniquely-tagged rows and deletes them in a `finally`, sizes each scenario to its rate-limit budget (limits stay on; 429s counted separately), and prints/writes p50/p95/p99, req/s and non-2xx per scenario to `docs/performance/load-baseline.md`. **Only the dry run (`GET /health`) was executed** — see Notes.
- Shared: `ReconciliationRunSummary`, `AdminMetricsOverview.payouts.stalePayouts`.
- **416 API tests (+35: 10 reconciliation, 19 security, 6 inventory), 48 web (+9: 6 CSP unit, 3 SSR), 6 shared; zero regressions.** `pnpm turbo run typecheck lint test build` (9/9 tasks) and root `pnpm lint` (incl. jsx-a11y) green; `pnpm audit --prod --audit-level=high` exits 0.

**Notes / deviations:**
- **GHSA-only advisories are excepted with `ignoreGhsas`, not `ignoreCves`.** Four of the Next advisories have no CVE id, so `ignoreCves` cannot name them; `ignoreGhsas` scopes each to its one advisory id, which is the spec's intent (no blanket ignore).
- **`pnpm update` rewrote two specifiers to the resolved version** (`sharp` `^0.35.2` → `^0.35.5`, `next` `^14.2.5` → `^14.2.35`). Both are in-range; no major changed.
- **Plugin-scoped hooks are resolved at `onReady`, not in `onRoute`.** Fastify attaches a plugin's `addHook` calls only after the plugin's routes are declared, so the admin plugin's `authenticate` is invisible at `onRoute` time. The collector records each route with its scope and resolves both flags once, at boot. Reading scoped hooks uses Fastify's internal `fastify.hooks` symbol, located by description; if a Fastify upgrade renames it, the inventory throws at boot instead of reporting routes as open.
- **Rate-limit gaps were closed rather than allowlisted**, with new budgets chosen per route (listed above) — new limits, not changed ones. The WebSocket limiter sits in `preValidation` after `authenticate`, since that is where the upgrade route authenticates.
- **`buildServer` gained two test/override options, `trustProxy` and `hsts`.** `env` is read once at import, so the D1/D2 "both settings" tests need a seam; both default to the env-derived value.
- **Fastify's `errorCodes.FST_ERR_CTP_INVALID_JSON_BODY` in the two webhook parsers** (payments, payouts) — a two-line change in each, needed so a malformed webhook body is a 400 `bad_request` instead of a 500 (a `SyntaxError` has no status).
- **`style-src` keeps `'unsafe-inline'`**: pages style elements through React `style={…}` attributes, which a nonce cannot cover. Scripts never get `'unsafe-inline'`.
- **The SSR harness now runs `next build`/`next start` with `NODE_ENV=production`.** Vitest exports `NODE_ENV=test` to child processes, which suppressed the production-only HSTS header; a deployed server runs as production. The five Session 10 locale tests are unchanged and pass.
- **Stale-payout idempotency is a deterministic primary key, not a read-then-write.** "Skip if one exists since UTC midnight" is implemented as the id `payout_stale_<payoutId>_<UTC date>`; a second insert the same day fails with P2002 and is counted as not flagged — true even for two overlapping runs.
- **`GENERATION_STALE_AFTER_MS` must exceed `GENERATION_TIMEOUT_MS` (boot fails otherwise).** The live success path completes a job with an unconditional `update`, so reconciling a job still inside its request budget could refund an image that then completes. Not in the spec text; it is the smallest guard that keeps D6 from contradicting Session 08.
- **`GenerationJob (status, createdAt)` and `PaymentTransaction (userId, modelId, type, status)` were evaluated and rejected** (reasons in the index review): the partial unique index already holds exactly the PENDING jobs, and the renewal check filters a few-row set.
- **D8 was run in dry-run mode only.** The only database configured is the shared Supabase project that holds the live schema; there is no separate local/dev Postgres on this machine (no `psql`/Docker). The full mode seeds and deletes rows, so it was not pointed at Supabase without an explicit decision. The full mode typechecks against the generated Prisma client but has not been executed. `docs/performance/load-baseline.md` states this.
- **`src/types/fastify-jwt.d.ts` declares `fastify.jwt.access` / `.refresh`** (they exist at runtime for namespaced registrations) so the tests and the load harness can mint a token without a login round-trip.
- **Pre-existing bug found, not fixed (outside D0–D8):** `storage-cleanup.yml` and `subscription-renewals.yml` send `Content-Type: application/json` with no body, which Fastify rejects with 400 before the route runs (`FST_ERR_CTP_EMPTY_JSON_BODY` — already the case before this session). The new `reconciliation.yml` sends no Content-Type. See Open Items. — fixed in the Session 12 addendum (header removed from both workflows).
- **ARIA validation:** no new `.tsx`; `eslint-plugin-jsx-a11y` green over all `**/*.tsx`.

**External Prerequisites:**
- [x] No new external accounts required
- [ ] Generate `RECONCILIATION_CRON_SECRET` (`openssl rand -hex 32`) and store it as a GitHub Actions repository secret (alongside `API_PUBLIC_URL`) and in the API environment
- [ ] Set `TRUST_PROXY` to the real hop count (or proxy CIDRs) of the deployment — Session 13
- [ ] Set `NEXT_PUBLIC_MEDIA_ORIGIN` to the storage host signed URLs point at, so the web CSP lets media load
- [ ] Run `pnpm --filter @creator-platform/api load` (full mode) against a non-production database to fill in the DB-backed baseline

---

### Session 12.5 — FX-Aware Payouts & Credit-Spend Revenue Share ⏳ Pending
**File:** `.claude/sessions/session-12.5.md` _(to be written)_  
**Domain:** Per-currency payouts with an FX policy, and attributing credit spend (via `GenerationJob.modelId`) to model earnings. Moved out of Session 12 because both need product decisions first (the FX policy; the model's share of a credit spend).

**External Prerequisites:**
- [ ] Product decision: FX policy for models earning in BRL and USD
- [ ] Product decision: the model's share of a credit spend

---

### Session 12.6 — Framework Upgrade: Next.js 16.3 (Active LTS) + React 19 ✅ Complete
**File:** `.claude/sessions/session-12.6.md`  
**Domain:** Like-for-like upgrade of `apps/web` from Next 14.2.35 / React 18.3 to Next 16.3.6 / React 19.3, removing all 12 Session 12 audit exceptions, closing `/_next/image`, and moving CI to Node 22. No feature, CSP-policy, locale-behaviour or `apps/api` source change.

**Summary:**
- **D0 — baseline.** `pnpm install --frozen-lockfile` and `pnpm turbo run typecheck test build` green before any change: 416 API / 48 web / 6 shared, 9/9 tasks.
- **D1 — dependencies (`apps/web`).** `next` **16.3.6** (newest 16.3.x; ≥ 16.3.3, the GHSA-2xp9-vwfh-vxw4 fix), `react`/`react-dom` **19.3.0**, `@types/react`/`@types/react-dom` **19.3.0**, `next-intl` **4.14.7** (peers: `next ^16`, `react ^19`). `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.1 and `jsdom` 25 already support React 19 — **not bumped**. `pnpm why next react react-dom` finds exactly one version of each; no peer-dependency warning, nothing silenced; `pnpm install --frozen-lockfile` passes on the new lockfile.
- **D2 — code migration.** `src/middleware.ts` → **`src/proxy.ts`**, exported `middleware` → `proxy`; `config.matcher` and every line of logic unchanged (`createNonce`, `buildContentSecurityPolicy`, `x-nonce` + CSP on the forwarded request, CSP on the response). `createNonce` needed no change on the Node.js proxy runtime (Web Crypto `getRandomValues` + `btoa` are global in Node 22); its unit test is unchanged. No other Next-16 code change was needed: `src/i18n/request.ts` already awaited `cookies()`/`headers()`, and no page reads `params`/`searchParams`/`draftMode`. No React 19 type errors surfaced (`tsc --noEmit` clean first time). `next.config.mjs` needed no option removed and builds under **Turbopack** (Next 16's default) with the next-intl plugin and `transpilePackages` as-is — no `--webpack` fallback.
- **D3 — `/_next/image` closed.** `images: { unoptimized: true }` in `next.config.mjs`. Verified on a real `next start` with a temporary PNG in `public/`: without it the optimizer answered `200 image/png`; with it, `404 text/html` — so no proxy/matcher change was needed. New real-server test in `ssr.test.ts`: `GET /_next/image?url=%2Ffavicon.ico&w=64&q=75` is 4xx, not `image/*`, and specifically **404** (with the optimizer on, that URL is the optimizer's own 400, since the app has no favicon — only a 404 proves the route is gone). Mutation check: removing the option fails it (`expected 400 to be 404`).
- **D4 — audit.** All 12 Next 14 / `postcss@8.4.31` exceptions deleted and the `pnpm.auditConfig` block **removed**. `pnpm audit --prod --audit-level=high` exits 0 with **zero exceptions**. Next 16.3.6 pins `postcss@8.5.23` (no advisory), so no `pnpm.overrides` entry. `docs/security/owasp-audit.md` A06 shows each former exception as resolved by Session 12.6.
- **D5 — Node 22.** All five `ci.yml` jobs `node-version: 22`; root `engines.node` `>=22`; `@types/node` `^22.20.4` in root, `apps/web` and `apps/api` (manifest only — typecheck clean). Cron workflows untouched (curl only).
- **D6 — parity.** All 48 pre-existing web tests pass with **no assertion changed**, including the 5 real-server locale tests and the 3 CSP/header tests (every `<script>` still carries the header's nonce; the nonce differs per request; `'strict-dynamic'`, no `'unsafe-eval'` in production). `/dev/protected-media` still 404s in production. **49 web (+1) / 416 API / 6 shared**; `pnpm turbo run typecheck lint test build --force` 9/9 and root `pnpm lint` (incl. jsx-a11y) green.
- **Build/perf (informational).** `next build` wall time 9.0 s → 4.9 s. Next 16 no longer prints First Load JS, so both versions were measured the same way (gzip of every non-`noModule` `<script src>` the production HTML loads): `/` 100.5 → 146.6 kB (**+46%**), `/wallet` 103.0 → 148.7 kB (**+44%**) — above the spec's 25% flag line (Next 14's own column had printed 87.4 / 102 kB).

**Notes / deviations:**
- **First Load JS grew ~45% on both pages.** Flagged per the performance requirement. No page code changed, so the growth comes from the framework side (React 19 + the Next 16 client runtime / Turbopack chunking); it was not broken down per chunk. Informational, not a gate; no action taken inside a like-for-like session.
- **First Load JS is a measured figure, not a build-printed one.** Next 16's build output dropped the Size/First Load JS columns, so "as printed by the build" is impossible; the smallest honest reading was to measure both versions identically (method above, Next 14 measured in a throwaway worktree at `5983872`).
- **The D3 test asserts 404, stricter than the spec's "4xx".** On this app the spec's URL is already 4xx with the optimizer *enabled* (400: no favicon exists), so "4xx" alone would not detect a regression. The 4xx + not-`image/*` assertions are kept as written, and `toBe(404)` is added.
- **`next-env.d.ts` stays tracked, but Next 16 regenerates it with no opt-out.** It now contains `import "./.next/types/routes.d.ts"` / `root-params.d.ts`, and the committed copy is the `.next` variant `next build` writes. The SSR test's `NEXT_DIST_DIR=.next-test` build rewrites those two lines to `.next-test/…`, leaving the file locally modified after a test run. Harmless to CI (TypeScript does not resolve side-effect imports by default, so a checkout without `.next/` still typechecks). Untracking it is Next's own recommendation but was outside "keep it tracked or untracked exactly as it is today".
- **`@types/node` 22 was also bumped in `apps/api/package.json`.** D5 asks for it "in each package"; manifest-only, no API source touched, API typecheck and 416 tests green.
- **Codemod not used.** The change set was small enough to make by hand, so there is nothing speculative to revert.
- **ARIA validation:** no `.tsx` changed; `eslint-plugin-jsx-a11y` green over all `**/*.tsx`.

**External Prerequisites:**
- [x] None

---

### Session 13 — MVP Deployment ⏳ Pending — **NEXT**
**File:** `.claude/sessions/session-13.md`  
**Domain:** Railway/Render/Fly.io deploy, managed DB, domain, SSL, monitoring — plus, moved here from Session 12, a shared (Redis) rate-limit store and cross-instance messaging pub/sub, both needed only once the API runs on more than one instance.

**External Prerequisites:**
- [ ] Choose and create hosting account (pick one):
  - Railway: https://railway.app → sign up with GitHub (free trial available)
  - Render: https://render.com → sign up with GitHub (free tier available)
  - Fly.io: https://fly.io → sign up → install flyctl CLI
- [ ] **Register a custom domain — required, not optional** (https://porkbun.com or https://namecheap.com). Web and API must be served from the same registrable domain (e.g. `app.<domain>` / `api.<domain>`): the API's CORP `same-site` and the `SameSite=Strict` auth cookies both break across sites, and platform default subdomains (`*.up.railway.app`, `*.onrender.com`, `*.fly.dev`) are on the Public Suffix List, so they count as different sites. See Open Items.
- [ ] Set up error monitoring: https://sentry.io → create account (free tier) → create project → copy `SENTRY_DSN`
- [ ] (Optional) Uptime monitoring: https://betterstack.com/uptime → free tier available
- [ ] (If running more than one API instance) Upstash Redis for the rate-limit store and messaging pub/sub: https://upstash.com → create Redis DB → copy `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN`
