# Creator Platform

A content monetization platform (OnlyFans-style) with **AI-powered image personalization**.
Models authorize the use of their likeness for AI-generated personalized images; subscribers pay
for preset options or custom prompts. A hidden system prompt anchors each model's likeness behind
every AI request. Built lean on free-tier/serverless tooling, with an architecture designed to swap
in more robust paid services as revenue scales.

- **Currencies:** USD, BRL, EUR (Stripe multi-currency)
- **Languages:** PT-BR + EN (i18n-ready from day one)
- **Repo:** https://github.com/soulevil09/creator-platform

---

## Tech Stack

| Layer    | Choice                                  | Why                                                                                                                                                                                                               | Link                                                               |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Monorepo | **pnpm workspaces + Turborepo**         | pnpm gives fast, disk-efficient installs with strict, symlinked workspaces; Turborepo caches `build`/`lint`/`test` per package. Both are free and lock-in-free.                                                   | [pnpm](https://pnpm.io) · [Turbo](https://turbo.build)             |
| Frontend | **Next.js 14 (App Router)**             | TypeScript-first React with SSR/ISR, file-based routing, and effortless deploy to serverless hosts. i18n-ready and easy to host anywhere Node runs.                                                               | [nextjs.org](https://nextjs.org)                                   |
| Backend  | **Fastify**                             | Lean, fast, low-overhead Node framework — a better fit for a budget/serverless start than NestJS's heavier footprint, while staying easy to structure as the API grows.                                           | [fastify.dev](https://fastify.dev)                                 |
| Shared   | **TypeScript package**                  | Framework-free `@creator-platform/shared` holds types/constants/utilities consumed by both web and api — one source of truth, no duplication.                                                                     | —                                                                  |
| ORM / DB | **Prisma + PostgreSQL (Supabase)**      | Prisma is TypeScript-first with a generated type-safe client and first-class migrations; Supabase offers managed Postgres on a no-credit-card free tier with storage/auth available later. Both are easy to swap. | [Prisma](https://www.prisma.io) · [Supabase](https://supabase.com) |
| Lint     | **ESLint 9 (flat) + typescript-eslint** | Single flat config at the root governs every package; modern, fast, and the de-facto TS standard.                                                                                                                 | [ESLint](https://eslint.org)                                       |
| Format   | **Prettier**                            | Zero-debate, consistent formatting across the whole repo.                                                                                                                                                         | [Prettier](https://prettier.io)                                    |
| Tests    | **Vitest**                              | ESM- and TypeScript-native, Jest-compatible API, fast, and unified config — less friction than Jest in a TS/ESM monorepo. `--passWithNoTests` keeps CI green before tests exist.                                  | [Vitest](https://vitest.dev)                                       |
| Payments | **Stripe**                              | Subscriptions + PPV + Connect (model payouts), multi-currency (USD/BRL/EUR).                                                                                                                                      | [Stripe](https://stripe.com)                                       |
| CI       | **GitHub Actions**                      | Free tier, native GitHub integration.                                                                                                                                                                             | [Actions](https://github.com/features/actions)                     |

---

## Prerequisites

- **Node.js 20 LTS** or newer (developed on Node 22)
- **pnpm 10+** — `npm install -g pnpm`
- A **Supabase** project for `DATABASE_URL` (free tier) — https://supabase.com

---

## Setup

```bash
# 1. Clone
git clone https://github.com/soulevil09/creator-platform.git
cd creator-platform

# 2. Install (also runs `prisma generate` in apps/api)
pnpm install

# 3. Configure environment
cp .env.example .env                  # root
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# then fill in the values (DATABASE_URL, JWT secrets, Stripe keys, …)

# 4. Run everything in dev
pnpm dev
```

Web runs at http://localhost:3000, API at http://localhost:4000 (`GET /health`).

### Root scripts

| Script                              | What it does                           |
| ----------------------------------- | -------------------------------------- |
| `pnpm dev`                          | Run all apps in watch mode (Turborepo) |
| `pnpm build`                        | Build all packages                     |
| `pnpm typecheck`                    | `tsc --noEmit` across every package    |
| `pnpm test`                         | Run Vitest across every package        |
| `pnpm lint` / `pnpm lint:fix`       | ESLint across the repo                 |
| `pnpm format` / `pnpm format:check` | Prettier write / check                 |

> **Note:** `.env*` files are gitignored. `.env.example` files contain placeholders only — never commit real secrets.

---

## Architecture

```
creator-platform/
├── apps/
│   ├── web/                 # Next.js 14 App Router frontend
│   │   └── src/app/         # routes (layout.tsx, page.tsx)
│   └── api/                 # Fastify backend
│       ├── src/index.ts     # server bootstrap + /health
│       └── prisma/          # schema.prisma (generated client gitignored)
├── packages/
│   └── shared/              # framework-free types, constants, utilities
├── .github/workflows/ci.yml # lint + typecheck + test
├── tsconfig.base.json       # strict TS base extended by every package
├── turbo.json               # task pipeline + caching
├── pnpm-workspace.yaml
└── eslint.config.mjs        # one flat ESLint config for the whole repo
```

**Package boundaries**

- `@creator-platform/shared` — no framework deps. Imported by both apps via path alias `@shared/*` and as a workspace dependency. Consumed directly from TypeScript source (no build step) in dev.
- `@creator-platform/web` — UI only; talks to the API over HTTP.
- `@creator-platform/api` — HTTP + data layer (Prisma). Owns the database schema.

TypeScript runs in **strict mode** everywhere via `tsconfig.base.json`. Path aliases: `@shared/*`,
`@web/*`, `@api/*`.

---

## Session Map

| #   | Session                  | Status      | Domain                                                           |
| --- | ------------------------ | ----------- | ---------------------------------------------------------------- |
| 01  | Bootstrap                | ✅ Complete | Monorepo, TS config, CI skeleton, env, README, Prisma init       |
| 02  | Auth                     | ⏳ Pending  | Registration (model/subscriber), login, JWT + refresh, RBAC      |
| 03  | Model Onboarding         | ⏳ Pending  | Profile data, reference image upload, AI consent/ToS             |
| 04  | Content Management       | ⏳ Pending  | Upload pipeline, signed URLs, watermarking, tiered access        |
| 05  | Subscription & PPV       | ⏳ Pending  | Stripe subscriptions, PPV unlocking, webhooks                    |
| 06  | Revenue Sharing          | ⏳ Pending  | Payout calc, model balances, Stripe Connect                      |
| 07  | Private Messaging        | ⏳ Pending  | Subscriber ↔ model chat (real-time/async)                        |
| 08  | AI Image Personalization | ⏳ Pending  | Likeness anchor engine, hidden prompt, preset/custom UI, billing |
| 09  | Anti-Leak & Protection   | ⏳ Pending  | Expiring signed URLs, screenshot deterrents, watermark hardening |
| 10  | i18n & Multilingual      | ⏳ Pending  | PT-BR + EN, i18n framework, externalized strings                 |
| 11  | Admin Dashboard          | ⏳ Pending  | Metrics, user mgmt, model approval, payout oversight, moderation |
| 12  | Security & Performance   | ⏳ Pending  | OWASP checklist, rate limiting, load test, DB indexes            |
| 13  | MVP Deployment           | ⏳ Pending  | Hosting, managed DB, domain, SSL, monitoring                     |

See `.claude/sessions/` and `CLAUDE.md` for full per-session detail.
