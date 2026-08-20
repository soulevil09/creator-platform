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
| Model payouts | Paxum mass payout REST API | Industry-standard for adult creator payouts. Automated weekly distribution via API. |
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
| Platform pays model | Paxum API (weekly) | Platform % kept; model % sent via mass payout |
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
  └── sendMassPayouts(recipients[]) → PayoutResult

PaxumPayoutAdapter   implements IPayoutProvider   ← model earnings distribution

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
  - `GET /api/content/:contentId/serve` — `authenticate` required; access check (owner/admin/FREE/valid non-expired `ContentAccess`, PREMIUM needs premium/ppv grant) else 403; images streamed watermarked with `Cache-Control: no-store`; videos return a 60s signed URL; `viewCount` bumped fire-and-forget.
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

### Session 05 — Payments ⏳ Pending
**File:** `.claude/sessions/session-05.md`  
**Domain:** Woovi PIX (subscriptions + credit packs), NOWPayments crypto (subscriptions + credit packs), provider-swappable IPaymentProvider + IPayoutProvider abstractions, webhook handling, credit wallet, mocked CCBill slot

**External Prerequisites:**
- [x] MEI aberto — CNPJ 67.735.318/0001-91 ativo na Receita Federal
- [x] Conta Nubank PJ criada — chave PIX CNPJ vinculada
- [x] Conta Woovi (OpenPix) criada em app.woovi.com — empresa "Creator Platform", CNPJ 67.735.318/0001-91, plano percentual 0,80%
  - [ ] Coletar `OPENPIX_APP_ID` no dashboard → API/Plugins
  - [ ] Coletar `OPENPIX_WEBHOOK_SECRET` no dashboard → Webhooks → criar webhook
- [ ] Criar conta NOWPayments: https://nowpayments.io → Sign Up
  - [ ] Coletar `NOWPAYMENTS_API_KEY` em Store Settings
  - [ ] Coletar `NOWPAYMENTS_IPN_SECRET` em IPN Settings
  - [ ] Conectar carteira USDT TRC-20 em Payout Settings

---

### Session 06 — Revenue Sharing ⏳ Pending
**File:** `.claude/sessions/session-06.md`  
**Domain:** Payout calculation, model balance tracking, Paxum API automated mass payouts

**External Prerequisites:**
- [ ] Create Paxum Business account: https://www.paxum.com → sign up as Business
  - Enable mass payout API: contact Paxum support to activate REST API access
  - Each model must also have a personal Paxum account (their email is used as payout recipient)
  - Get `PAXUM_API_KEY` and `PAXUM_IPN_SECRET` from Merchant Services → IPN Settings

---

### Session 07 — Private Messaging ⏳ Pending
**File:** `.claude/sessions/session-07.md`  
**Domain:** Real-time or async chat between subscriber and model

**External Prerequisites:**
- [ ] No new external accounts required
- [ ] (Optional) If using Pusher for WebSockets: https://pusher.com → create account (free tier) → create app → copy keys

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

**Swap-readiness notes:** DB provider swappable behind Prisma; AI provider behind `AI_PROVIDER` env switch; storage behind S3-compatible env vars; email provider behind the `Emailer` interface; image processing behind the `ImageProcessor` interface; PIX payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_PIX` env); crypto payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_CRYPTO` env); card payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_CARD` env, mocked until CCBill activation); payout provider behind `IPayoutProvider`.

---

## Repository Structure

```
creator-platform/
├── apps/
│   ├── web/                         # Next.js 14 App Router (@creator-platform/web)
│   │   ├── src/app/layout.tsx
│   │   ├── src/app/page.tsx
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
│       │   │   └── content/
│       │   │       ├── content.routes.ts
│       │   │       ├── content.service.ts
│       │   │       ├── content.schema.ts
│       │   │       └── content.test.ts      # 15 tests
│       │   └── types/
│       │       └── fastify-jwt.d.ts
│       ├── prisma/
│       │   ├── schema.prisma        # User + ModelProfile + Content models, enums
│       │   ├── migrations/          # …_add_user_model, …_add_model_profile, …_add_content_management
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
├── .github/workflows/ci.yml
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
| `PAYMENT_PROVIDER_CRYPTO` | api | 05 | Active crypto adapter: `nowpayments` |
| `NOWPAYMENTS_API_KEY` | api | 05 | NOWPayments API key |
| `NOWPAYMENTS_IPN_SECRET` | api | 05 | NOWPayments IPN (webhook) secret |
| `PAYMENT_PROVIDER_CARD` | api | 05 | Active card adapter: `mock` (CCBill when activated post-MVP) |
| `CCBILL_ACCOUNT_NUMBER` | api | _post-MVP_ | CCBill main account number (6-digit) — deferred |
| `CCBILL_SUBACCOUNT` | api | _post-MVP_ | CCBill subaccount number (4-digit) — deferred |
| `CCBILL_SALT` | api | _post-MVP_ | CCBill webhook HMAC salt — deferred |
| `CCBILL_API_USERNAME` | api | _post-MVP_ | CCBill REST API username — deferred |
| `CCBILL_API_PASSWORD` | api | _post-MVP_ | CCBill REST API password — deferred |
| `PAXUM_API_KEY` | api | 06 | Paxum REST API key for mass payouts |
| `PAXUM_IPN_SECRET` | api | 06 | Paxum IPN shared secret for webhook validation |
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
- **Woovi adult content policy** — Woovi/OpenPix é um gateway PIX brasileiro regulado. Antes de ir ao ar em produção com conteúdo explícito adulto, confirmar com o suporte deles (suporte@woovi.com) se aceitam plataformas adult 18+. PIX em si não tem restrição de conteúdo (é infraestrutura do Banco Central), mas o gateway pode ter política própria.
- **CCBill deferred to post-MVP** — $1,450/yr Visa+MC registration fees make card processing financially unviable at MVP stage. CCBill slot is scaffolded as `MockPaymentProvider`. Activate when monthly revenue covers the annual fee.
- **NOWPayments crypto-to-fiat conversion** — NOWPayments settles in cryptocurrency. To receive BRL/USD fiat, platform must maintain exchange accounts (Bybit/OKX/Binance) and execute regular USDT→fiat withdrawals. This is an operational step outside the codebase.
- **Lei FELCA compliance (Brazil)** — Lei 15.211/2025 requires adult platforms to implement CPF + Face ID age verification by 17/03/2026. Penalties: up to R$50M or 10% of annual Brazil revenue. Must be scoped into a future session (candidate: Session 09 or a new Session 9.5). ANPD is the enforcement authority.
- **Paxum → Woovi/NOWPayments wire** — model payouts via Paxum require platform to accumulate earnings from Woovi and NOWPayments, then fund the Paxum business account. This is a manual treasury step outside the codebase; document the SOP before Session 06.
- **MEI faturamento limit** — MEI CNPJ 67.735.318/0001-91 has R$130k/year revenue cap. When platform revenue approaches this threshold, migrate to ME (Microempresa) with a contador. This unlocks higher volume and formal payroll if needed.
- **Telegram Stars** — optional secondary channel for microtransactions on Telegram bots. ~32% effective fee on mobile purchases. 21-day withdrawal hold. iOS restrictions on adult content via Stars. Not a primary payment channel — integrate only if there is an active Telegram community.

---

## Last Updated — Session 04 complete / PIX provider updated to Woovi (OpenPix) — MEI CNPJ 67.735.318/0001-91 + Nubank PJ + Woovi conta criada [2026-06-29]
