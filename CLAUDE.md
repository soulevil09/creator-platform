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
> Finalized during Session 01 by Claude Code. To be updated after session completes.

| Layer | Choice | Justification |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Fast, disk-efficient, strict symlinked workspaces; Turborepo caches build/lint/test. Free, no lock-in. |
| Frontend | Next.js 14 (App Router) | TypeScript-first React, SSR/ISR, file routing, serverless-friendly deploy, i18n-ready. |
| Backend | Fastify | Lean, fast, low-overhead — better fit for a budget/serverless start than NestJS, still scalable. |
| ORM / DB | Prisma + PostgreSQL (Supabase) | Prisma = TS-first, type-safe client, migrations, swappable provider. Supabase = managed free Postgres, no card. |
| Auth | JWT (access + refresh) — _Session 02_ | Stateless, framework-agnostic, no vendor lock-in; refresh-token rotation for security. Implemented next session. |
| Storage | Supabase Storage / Cloudflare R2 — _Session 03_ | Both have free tiers + signed URLs; choice finalized at Session 03/04. |
| Email | Resend — _Session 02_ | Free tier, simple API for transactional email. |
| AI Images | Replicate (SDXL) — _Session 08_ | Pay-per-use, no subscription, hosted SDXL; swappable behind an `AI_PROVIDER` abstraction. |
| Payments | Stripe | Subscriptions + PPV + Connect (model payouts) |
| Lint / Format | ESLint 9 (flat) + Prettier | One root config governs all packages; modern TS standard. |
| Tests | Vitest | ESM/TS-native, Jest-compatible, fast; `--passWithNoTests` keeps CI green pre-tests. |
| CI | GitHub Actions | Free tier, native GitHub integration |

---

## Session Map

### Session 01 — Bootstrap
**File:** `.claude/sessions/session-01.md`  
**Status:** ✅ Complete  
**Domain:** Monorepo structure, TypeScript config, CI skeleton, env setup, README, Prisma init  

**External Prerequisites:**
- [ ] Create GitHub repo: https://github.com/new → name: `creator-platform` (private, no README)
- [ ] Install Node.js 20 LTS: https://nodejs.org
- [ ] Install pnpm: https://pnpm.io/installation
- [ ] Install Claude Code CLI: https://docs.anthropic.com/claude-code
- [ ] Create Supabase account (free): https://supabase.com → create a new project → copy `DATABASE_URL`

---

### Session 02 — Auth
**File:** `.claude/sessions/session-02.md`  
**Status:** ⏳ Pending  
**Domain:** Registration (model/subscriber roles), login, JWT + refresh tokens, RBAC middleware  

**External Prerequisites:**
- [ ] Supabase project must be running (from Session 01)
- [ ] Copy `DATABASE_URL` from Supabase dashboard → Settings → Database
- [ ] Set up transactional email: https://resend.com → create account (free tier) → generate API key → verify sending domain

---

### Session 03 — Model Onboarding
**File:** `.claude/sessions/session-03.md`  
**Status:** ⏳ Pending  
**Domain:** Model profile data, reference image upload, AI consent/ToS flow  

**External Prerequisites:**
- [ ] Set up object storage: https://supabase.com/storage OR https://cloudflare.com/r2 → create bucket → copy endpoint, access key, secret key
- [ ] (Optional) Cloudflare R2 free tier: https://dash.cloudflare.com → R2 → Create bucket

---

### Session 04 — Content Management
**File:** `.claude/sessions/session-04.md`  
**Status:** ⏳ Pending  
**Domain:** Upload pipeline, signed URL serving, watermarking, tier-based access control  

**External Prerequisites:**
- [ ] Storage bucket from Session 03 must be configured
- [ ] Confirm storage provider choice (Supabase Storage or Cloudflare R2) is finalized

---

### Session 05 — Subscription & PPV
**File:** `.claude/sessions/session-05.md`  
**Status:** ⏳ Pending  
**Domain:** Stripe subscription plans, PPV unlocking, webhook handling  

**External Prerequisites:**
- [ ] Create Stripe account: https://stripe.com → complete business profile
- [ ] Enable test mode: https://dashboard.stripe.com/test/dashboard
- [ ] Copy keys from: https://dashboard.stripe.com/test/apikeys → `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`
- [ ] Set up webhook endpoint: https://dashboard.stripe.com/test/webhooks → add endpoint → copy `STRIPE_WEBHOOK_SECRET`
- [ ] Enable multi-currency (USD, BRL, EUR): https://dashboard.stripe.com/settings/currencies
- [ ] Install Stripe CLI for local webhook testing: https://stripe.com/docs/stripe-cli

---

### Session 06 — Revenue Sharing
**File:** `.claude/sessions/session-06.md`  
**Status:** ⏳ Pending  
**Domain:** Payout calculation, model balance tracking, Stripe Connect  

**External Prerequisites:**
- [ ] Stripe account must be active (from Session 05)
- [ ] Enable Stripe Connect: https://dashboard.stripe.com/settings/connect → enable Standard or Express accounts
- [ ] Complete Stripe platform profile for Connect: https://dashboard.stripe.com/settings/connect/profile
- [ ] Copy `STRIPE_CONNECT_CLIENT_ID` from Connect settings

---

### Session 07 — Private Messaging
**File:** `.claude/sessions/session-07.md`  
**Status:** ⏳ Pending  
**Domain:** Real-time or async chat between subscriber and model  

**External Prerequisites:**
- [ ] No new external accounts required
- [ ] (Optional) If using Pusher for WebSockets: https://pusher.com → create account (free tier) → create app → copy keys

---

### Session 08 — AI Image Personalization
**File:** `.claude/sessions/session-08.md`  
**Status:** ⏳ Pending  
**Domain:** Likeness anchor engine, hidden system prompt, preset + custom UI, billing  

**External Prerequisites:**
- [ ] Create Replicate account: https://replicate.com → sign up → go to https://replicate.com/account/api-tokens → generate token → copy `AI_PROVIDER_API_KEY`
- [ ] Review SDXL model on Replicate: https://replicate.com/stability-ai/sdxl
- [ ] Add billing method on Replicate (pay-per-use, no subscription needed): https://replicate.com/account/billing

---

### Session 09 — Anti-Leak & Content Protection
**File:** `.claude/sessions/session-09.md`  
**Status:** ⏳ Pending  
**Domain:** Signed expiring URLs, screenshot deterrents, watermark hardening  

**External Prerequisites:**
- [ ] No new external accounts required
- [ ] Storage provider from Session 03 must support signed URLs (Supabase Storage and R2 both do)

---

### Session 10 — i18n & Multilingual
**File:** `.claude/sessions/session-10.md`  
**Status:** ⏳ Pending  
**Domain:** PT-BR + EN, i18n framework, all strings externalized  

**External Prerequisites:**
- [ ] No new external accounts required

---

### Session 11 — Admin Dashboard
**File:** `.claude/sessions/session-11.md`  
**Status:** ⏳ Pending  
**Domain:** Metrics, user management, model approval, payout oversight, moderation  

**External Prerequisites:**
- [ ] No new external accounts required
- [ ] (Optional) Analytics: https://posthog.com → create account (free tier) → copy project API key

---

### Session 12 — Security Hardening & Performance Audit
**File:** `.claude/sessions/session-12.md`  
**Status:** ⏳ Pending  
**Domain:** OWASP checklist, rate limiting, load test, DB index review  

**External Prerequisites:**
- [ ] No new external accounts required
- [ ] (Optional) Upstash Redis for rate limiting: https://upstash.com → create account (free tier) → create Redis DB → copy `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN`

---

### Session 13 — MVP Deployment
**File:** `.claude/sessions/session-13.md`  
**Status:** ⏳ Pending  
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

- **pnpm workspaces + Turborepo** for the monorepo: strict, symlinked, disk-efficient installs with
  cached task running. No vendor lock-in; both free.
- **Next.js 14 (App Router)** frontend: SSR/ISR, file-based routing, i18n-ready, deployable to any
  Node/serverless host.
- **Fastify** backend over NestJS: leaner and lower-overhead for a budget/serverless start, while
  remaining straightforward to structure as the API grows.
- **Prisma + PostgreSQL (Supabase)**: type-safe generated client + migrations; Supabase gives managed
  free Postgres (no credit card) with storage/auth available later. The generated client outputs to
  `apps/api/prisma/generated/` (gitignored).
- **Internal packages consumed from source**: `@creator-platform/shared` exposes its `src/` directly
  (via `main`/`types`/`exports`), so web and api typecheck/run without a separate build step in dev.
- **ESLint 9 flat config + Prettier** at the root: one source of truth governs every package.
- **Vitest** as the test runner: ESM/TS-native, Jest-compatible; `--passWithNoTests` keeps CI green
  until real tests land.
- **Strict TypeScript everywhere** via `tsconfig.base.json` (`strict: true`), with path aliases
  `@shared/*`, `@web/*`, `@api/*`.
- **CI (GitHub Actions)** runs three parallel jobs — `lint`, `typecheck`, `test` — on push/PR to `main`,
  using pnpm with caching on Node 20.

**Swap-readiness notes:** DB provider is swappable behind Prisma; AI provider behind an `AI_PROVIDER`
env switch; storage behind S3-compatible env vars (Supabase Storage or Cloudflare R2). None of these
choices require a major refactor to upgrade to paid/robust tiers.

---

## Repository Structure
```
creator-platform/
├── apps/
│   ├── web/                    # Next.js 14 App Router frontend (@creator-platform/web)
│   │   ├── src/app/            # routes: layout.tsx, page.tsx
│   │   ├── next.config.mjs
│   │   ├── tsconfig.json
│   │   └── .env.example
│   └── api/                    # Fastify backend (@creator-platform/api)
│       ├── src/index.ts        # server bootstrap + GET /health
│       ├── prisma/schema.prisma  # provider + datasource (no models yet)
│       ├── scripts/postinstall.mjs # tolerant `prisma generate` wrapper
│       ├── tsconfig.json
│       └── .env.example
├── packages/
│   └── shared/                 # framework-free types/constants/utils (@creator-platform/shared)
│       └── src/index.ts
├── .github/workflows/ci.yml    # lint + typecheck + test
├── .claude/sessions/           # session specs (session-01.md …)
├── tsconfig.base.json          # strict TS base, extended by every package
├── turbo.json                  # task pipeline + caching
├── eslint.config.mjs           # one flat ESLint config for the repo
├── .prettierrc / .prettierignore
├── pnpm-workspace.yaml
├── .env.example                # root env template
├── CLAUDE.md
└── README.md
```

---

## Environment Variables Required
Templates live in `.env.example` (root), `apps/api/.env.example`, and `apps/web/.env.example`.
All `.env*` files are gitignored; examples contain placeholders only.

| Variable | Scope | Purpose |
|---|---|---|
| `DATABASE_URL` | api | Supabase Postgres connection string (`postgresql://…`) |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | api | Signing secrets for access/refresh tokens (Session 02) |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | api | Token lifetimes (`15m` / `7d`) |
| `STRIPE_SECRET_KEY` | api | Stripe server key |
| `STRIPE_WEBHOOK_SECRET` | api | Stripe webhook signing secret |
| `STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | web | Stripe client key |
| `STORAGE_ENDPOINT` / `STORAGE_BUCKET` / `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | api | Object storage (Supabase Storage or R2) |
| `AI_PROVIDER` / `AI_PROVIDER_API_KEY` | api | AI image provider switch + key (Replicate) |
| `EMAIL_API_KEY` / `EMAIL_FROM` | api | Transactional email (Resend) |
| `API_PORT` / `APP_URL` | api | Server port + allowed CORS origin |
| `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_API_URL` | web | Public URLs for the web app |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | web | Default UI locale (`pt-BR` \| `en`) |
| `NODE_ENV` | both | Runtime environment |

---

## Open Items / Known Issues
- Currency support: USD, BRL, EUR — Stripe must be configured for multi-currency
- Free-tier first: all tooling choices must have a usable free tier at MVP
- Scalability requirement: architecture must allow swapping to paid/robust tiers without major refactor

---

## Last Updated — Session 01 complete [2026-06-18]