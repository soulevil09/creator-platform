# CLAUDE.md — Creator Platform

## Project Overview
A content monetization platform (OnlyFans-style) with AI-powered image personalization for subscribers.
Models authorize use of their likeness for AI-generated personalized images. Subscribers pay for preset
options or custom prompts. A hidden system prompt anchors the model's likeness behind every AI request.

**GitHub:** https://github.com/soulevil09/creator-platform  
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
| Payments | Stripe | Subscriptions + PPV + Connect (model payouts). |
| Lint / Format | ESLint 9 (flat) + Prettier | One root config governs all packages; modern TS standard. |
| Tests | Vitest | ESM/TS-native, Jest-compatible, fast. In-memory mocks for DB + email in auth tests. |
| CI | GitHub Actions | Free tier, native GitHub integration. |

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
  - `grantContentAccess` / `revokeContentAccess` service functions (upsert/deleteMany on `contentId+userId`) — used by `/serve` (owner audit) now, by Session 05's Stripe webhooks later.
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

### Session 05 — Subscription & PPV ⏳ Pending
**File:** `.claude/sessions/session-05.md`  
**Domain:** Stripe subscription plans, PPV unlocking, webhook handling

**External Prerequisites:**
- [ ] Create Stripe account: https://stripe.com → complete business profile
- [ ] Enable test mode: https://dashboard.stripe.com/test/dashboard
- [ ] Copy keys from: https://dashboard.stripe.com/test/apikeys → `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`
- [ ] Set up webhook endpoint: https://dashboard.stripe.com/test/webhooks → add endpoint → copy `STRIPE_WEBHOOK_SECRET`
- [ ] Enable multi-currency (USD, BRL, EUR): https://dashboard.stripe.com/settings/currencies
- [ ] Install Stripe CLI for local webhook testing: https://stripe.com/docs/stripe-cli

---

### Session 06 — Revenue Sharing ⏳ Pending
**File:** `.claude/sessions/session-06.md`  
**Domain:** Payout calculation, model balance tracking, Stripe Connect

**External Prerequisites:**
- [ ] Stripe account must be active (from Session 05)
- [ ] Enable Stripe Connect: https://dashboard.stripe.com/settings/connect → enable Standard or Express accounts
- [ ] Complete Stripe platform profile for Connect: https://dashboard.stripe.com/settings/connect/profile
- [ ] Copy `STRIPE_CONNECT_CLIENT_ID` from Connect settings

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
**Domain:** Likeness anchor engine, hidden system prompt, preset + custom UI, billing

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
- **Tier access via `ContentAccess` rows** — a `contentId+userId` join with `grantReason` + optional `expiresAt`, checked server-side on every serve/list. `grantContentAccess`/`revokeContentAccess` are the write primitives Session 05's Stripe webhooks will call.
- **`cuid2` for storage keys** — collision-resistant content IDs in `content/{modelId}/{cuid2}.{ext}`.

**Swap-readiness notes:** DB provider swappable behind Prisma; AI provider behind `AI_PROVIDER` env switch; storage behind S3-compatible env vars; email provider behind the `Emailer` interface; image processing behind the `ImageProcessor` interface.

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
│       │   │   │   ├── auth.routes.ts   # HTTP layer: cookies, JWT signing, rate limits
│       │   │   │   ├── auth.service.ts  # Business logic: register, login, refresh, logout
│       │   │   │   ├── auth.schema.ts   # Zod validation schemas
│       │   │   │   └── auth.test.ts     # 17 integration + unit tests
│       │   │   ├── onboarding/
│       │   │   │   ├── onboarding.routes.ts   # HTTP: multipart, magic-byte validation, rate limits
│       │   │   │   ├── onboarding.service.ts  # Business logic: profile, consent, reference images
│       │   │   │   ├── onboarding.schema.ts   # Zod validation schemas
│       │   │   │   └── onboarding.test.ts     # 21 integration tests
│       │   │   └── content/
│       │   │       ├── content.routes.ts      # HTTP: multipart, size caps, serve/watermark, rate limits
│       │   │       ├── content.service.ts     # Business logic: upload, access control, serve, grant/revoke
│       │   │       ├── content.schema.ts      # Zod validation schemas
│       │   │       └── content.test.ts        # 15 integration tests
│       │   └── types/
│       │       └── fastify-jwt.d.ts # Module augmentation for namespaced JWT decorators
│       ├── prisma/
│       │   ├── schema.prisma        # User + ModelProfile + Content models, enums
│       │   ├── migrations/          # …_add_user_model, …_add_model_profile, …_add_content_management
│       │   └── generated/           # Prisma client output (gitignored)
│       ├── scripts/
│       │   └── postinstall.mjs      # Tolerant `prisma generate` wrapper
│       ├── vitest.config.ts
│       ├── vitest.setup.ts          # Test env + secret stubs
│       ├── tsconfig.json
│       └── .env.example
├── packages/
│   └── shared/                      # Framework-free types/constants/utils
│       └── src/index.ts             # Role, JwtPayload, AuthUser + locale/currency constants
├── .github/workflows/ci.yml         # lint + typecheck + test (parallel jobs)
├── .claude/sessions/                # Session specs (session-01.md, session-02.md …)
├── tsconfig.base.json               # strict TS base extended by every package
├── turbo.json                       # Task pipeline + caching
├── eslint.config.mjs                # Flat ESLint config for the whole repo
├── .prettierrc / .prettierignore
├── pnpm-workspace.yaml
├── .env.example                     # Root env template
├── CLAUDE.md
└── README.md
```

---

## Environment Variables Required

Templates live in `.env.example` (root) and `apps/api/.env.example`.
All `.env*` files are gitignored; examples contain placeholders only.

| Variable | Scope | Session | Purpose |
|---|---|---|---|
| `DATABASE_URL` | api | 01 | Supabase Postgres connection string (`postgresql://…`) |
| `JWT_SECRET` | api | 02 | Access token signing secret (min 32 chars) |
| `JWT_REFRESH_SECRET` | api | 02 | Refresh token signing secret (min 32 chars, different value) |
| `JWT_EXPIRES_IN` | api | 02 | Access token lifetime (`15m`) |
| `JWT_REFRESH_EXPIRES_IN` | api | 02 | Refresh token lifetime (`7d`) |
| `EMAIL_API_KEY` | api | 02 | Resend API key (`re_…`) |
| `EMAIL_FROM` | api | 02 | Sender address (`noreply@yourdomain.com`) |
| `APP_URL` | api | 02 | Allowed CORS origin + base URL for email links |
| `API_PORT` | api | 01 | Fastify listen port (default `4000`) |
| `NODE_ENV` | both | 01 | Runtime environment |
| `STRIPE_SECRET_KEY` | api | 05 | Stripe server key |
| `STRIPE_WEBHOOK_SECRET` | api | 05 | Stripe webhook signing secret |
| `STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | web | 05 | Stripe client key |
| `STORAGE_ENDPOINT` / `STORAGE_BUCKET` / `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | api | 03 | Object storage (Supabase Storage S3 endpoint + S3 key pair) |
| `STORAGE_REGION` | api | 03 | SigV4 signing region for S3 client (default `us-east-1`) |
| `AI_PROVIDER` / `AI_PROVIDER_API_KEY` | api | 08 | AI image provider switch + key (Replicate) |
| `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_API_URL` | web | — | Public URLs for the web app |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | web | 10 | Default UI locale (`pt-BR` \| `en`) |

---

## Open Items / Known Issues

- `.turbo/` cache folder should be added to `.gitignore` (minor, non-blocking)
- Stripe multi-currency (USD, BRL, EUR) to be configured in Session 05
- No frontend auth UI yet — login/register pages arrive in a future session
- Free-tier first: all tooling choices must have a usable free tier at MVP
- Architecture must allow swapping to paid/robust tiers without a major refactor
- **Video watermarking out of scope** (Session 04) — no ffmpeg/ffprobe; videos are served via a 60s signed URL with no server-side watermark, and `Content.durationSecs` stays null. Harden in a later session.
- **Content uploads buffer the full file into memory before storage write** (Session 04) — acceptable at MVP; true streaming needs the S3 multipart upload API (deferred).
- **Soft-deleted content objects are left in storage** (Session 04) — a cleanup job to purge `deletedAt` rows' objects is deferred (Session 09/12 candidate).
- **Locked-teaser listing deferred** (Session 04) — the list endpoint hides inaccessible gated content rather than returning it with a null thumbnail; revisit if the UI wants upsell teasers.

---

## Last Updated — Session 04 complete [2026-06-21]