# Session 01 — Bootstrap

> **File location:** `.claude/sessions/session-01.md`  
> **Run this file inside:** the root of the `creator-platform` repo after creating it on GitHub.

---

## Context Recap
- Platform: content monetization + AI image personalization (OnlyFans-style)
- Tech stack: TypeScript throughout — frameworks chosen by Claude Code with justification
- Budget: lean start — all tools must have a free tier; architecture must be swap-ready as revenue grows
- Currencies: USD, BRL, EUR (Stripe multi-currency)
- Languages: PT-BR + EN base, i18n-ready from day one
- GitHub repo: https://github.com/soulevil09/creator-platform

---

## Pre-Session Checklist
Before starting, confirm:
- [ ] GitHub repo `creator-platform` created (private, no README initialized)
- [ ] Node.js 20 LTS installed
- [ ] pnpm installed
- [ ] Supabase project created and `DATABASE_URL` available

---

## Objective
Set up the complete project foundation: monorepo structure, TypeScript configuration, environment
variable management, CI pipeline skeleton, and a meaningful README. No application logic yet —
this session is purely infrastructure and scaffolding.

---

## Deliverables & Acceptance Criteria

### 1. Monorepo Structure
- Use a monorepo tool — recommend `pnpm workspaces` + `Turborepo`; justify your choice
- Minimum packages:
  - `apps/web` — frontend (recommend Next.js 14+ App Router; justify)
  - `apps/api` — backend (recommend NestJS or Fastify; justify)
  - `packages/shared` — shared types, constants, utilities (TypeScript only, no framework)
- Each package has its own `package.json` and `tsconfig.json`
- Root `tsconfig.base.json` with strict mode enabled (`"strict": true`)
- Root `package.json` with workspace definition and shared dev scripts (`dev`, `build`, `lint`, `typecheck`, `test`)

### 2. TypeScript Configuration
- Strict mode enabled across all packages (`"strict": true`)
- Path aliases configured (e.g., `@shared/*`, `@web/*`, `@api/*`)
- Build outputs go to `dist/` in each package
- `ts-node` or equivalent available for local API development

### 3. Environment Variable Management
- `.env.example` at repo root AND in each app (`apps/web/.env.example`, `apps/api/.env.example`)
- Use `dotenv` or framework-native env loading — no hardcoded values anywhere
- `.env` files added to `.gitignore`
- Every variable must have a descriptive comment in `.env.example`
- Required variables (minimum):

```
# ─── Database ───────────────────────────────────────────
# Supabase connection string (Settings > Database > Connection string)
DATABASE_URL=https://cwlewexnhmfyamvpubio.supabase.co

# ─── Auth ────────────────────────────────────────────────
# Random secret for signing JWT access tokens (min 32 chars)
JWT_SECRET=
# Random secret for signing JWT refresh tokens (min 32 chars)
JWT_REFRESH_SECRET=
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# ─── Stripe ──────────────────────────────────────────────
# From: https://dashboard.stripe.com/test/apikeys
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
# From: https://dashboard.stripe.com/test/webhooks
STRIPE_WEBHOOK_SECRET=

# ─── Storage (Supabase Storage or Cloudflare R2) ─────────
STORAGE_ENDPOINT=
STORAGE_BUCKET=
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=

# ─── AI Image Generation (Replicate) ─────────────────────
# From: https://replicate.com/account/api-tokens
AI_PROVIDER_API_KEY=
AI_PROVIDER=replicate

# ─── Email (Resend) ──────────────────────────────────────
# From: https://resend.com/api-keys
EMAIL_API_KEY=
EMAIL_FROM=noreply@yourdomain.com

# ─── App ─────────────────────────────────────────────────
APP_URL=http://localhost:3000
API_URL=http://localhost:4000
NODE_ENV=development
```

### 4. CI Pipeline Skeleton (GitHub Actions)
- File: `.github/workflows/ci.yml`
- Triggers: push to `main`, pull requests to `main`
- Jobs:
  - `lint` — run ESLint across all packages
  - `typecheck` — run `tsc --noEmit` across all packages
  - `test` — run test runner (Jest or Vitest — justify choice); passes even with 0 test files
- Use pnpm with caching (`actions/cache` or `pnpm/action-setup`)
- Node version: 20 LTS (`actions/setup-node@v4`)

### 5. Code Quality Tooling
- ESLint with `@typescript-eslint` plugin configured at root
- Prettier configured at root with `.prettierrc`
- Both applied to all packages via root config
- Scripts in root `package.json`: `lint`, `lint:fix`, `format`, `format:check`

### 6. README.md
- Project name + one-paragraph description
- Tech stack table: tool name, role, justification, and link
- Prerequisites: Node version, pnpm version
- Setup instructions: clone → install → copy `.env.example` → fill env vars → run dev
- Section: "Session Map" — all 13 sessions with status (mirror CLAUDE.md)
- Section: "Architecture" — monorepo package descriptions

### 7. Database Setup (schema only — no migrations yet)
- **Database:** PostgreSQL via Supabase (free tier, hosted, no credit card required)
  - Justify: managed free PostgreSQL, built-in storage, auth helpers available if needed later
- **ORM:** Prisma (justify: TypeScript-first, great DX, migration support, easy to swap DB provider)
- Initialize Prisma in `apps/api`: `npx prisma init`
- `schema.prisma` must have:
  - `provider = "postgresql"`
  - `datasource db` pointing to `env("DATABASE_URL")`
  - `generator client` configured
  - No models yet — those come in Session 02+
- Add `prisma/` to `.gitignore` exceptions (keep schema, ignore generated client)
- Add `postinstall` script to run `prisma generate`

### 8. Session Files Setup
- Create folder `.claude/sessions/` at repo root
- Copy this file into `.claude/sessions/session-01.md`
- Copy `CLAUDE.md` into repo root

---

## Security Requirements
- No secrets in any committed file — all `.env` files must be gitignored
- `.env.example` must contain only placeholder/example values — never real keys
- `.gitignore` must cover at minimum:
  ```
  node_modules/
  dist/
  .env
  .env.local
  .env.*.local
  *.log
  .turbo/
  .next/
  prisma/generated/
  ```

---

## Performance Requirements
- `pnpm install` must complete without errors
- `pnpm run typecheck` must pass with 0 TypeScript errors
- `pnpm run lint` must pass with 0 ESLint errors
- CI pipeline must complete successfully on first push to `main`

---

## Tech Choices Guidance
Claude Code must briefly justify each major choice (1–2 sentences) in:
1. A comment block at the top of relevant config files
2. The README.md tech stack table
3. `CLAUDE.md` under "Architecture Decisions"

**Priorities:**
- Free tier available at MVP
- TypeScript-first
- Serverless-friendly or easy to self-host
- Easy to swap/upgrade components later without major refactor

---

## Definition of Done
- [ ] Monorepo created: `apps/web`, `apps/api`, `packages/shared` all present
- [ ] TypeScript strict mode enabled; `pnpm run typecheck` passes with 0 errors in all packages
- [ ] `.env.example` present in root, `apps/web`, and `apps/api` — all variables documented with comments
- [ ] `.env` is gitignored; no real secrets committed
- [ ] `.github/workflows/ci.yml` present; lint + typecheck + test jobs defined
- [ ] ESLint + Prettier configured and `pnpm run lint` passes with 0 errors
- [ ] README.md complete: description, tech stack table with justifications, setup instructions, session map
- [ ] Prisma initialized in `apps/api`; `schema.prisma` has provider + datasource configured; no models yet
- [ ] `.claude/sessions/` folder exists with `session-01.md` and `CLAUDE.md` at repo root
- [ ] All framework/tool choices documented in README + CLAUDE.md under Architecture Decisions
- [ ] ARIA validation passed before proceeding to Session 02