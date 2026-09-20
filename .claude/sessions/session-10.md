# Session 10 — i18n & Multilingual

## Context Recap (from CLAUDE.md)

- Sessions 01–09 are complete. Session 09.5 (Lei FELCA age verification) was deliberately deferred as an accepted business risk on 2026-09-14 — it is **not** part of this session and must not be touched.
- Stack: Next.js 14 App Router (`apps/web`), Fastify 5 + Prisma/Supabase (`apps/api`), pnpm + Turborepo monorepo, Vitest everywhere.
- The platform's base languages are **PT-BR and EN, i18n-ready**, per the original project brief. `NEXT_PUBLIC_DEFAULT_LOCALE` is already reserved in the Environment Variables table for this exact session.
- Every user-facing string in the codebase today is hardcoded in English: the four `apps/web` pages/components, the two transactional email templates, and the three shared product catalogs (`SUBSCRIPTION_PLANS`, `CREDIT_PACKS`, `GENERATION_PRESETS`).
- Two Open Items already point here: "Renewal reminders are not internationalized (Session 06.5) — externalized in Session 10" and the "PT-BR/EN" note on every catalog label.

## Objective

Introduce a real i18n framework across the web app and the API, externalize **every** existing user-facing string into PT-BR/EN message catalogs, and establish the locale-resolution and persistence pattern that every future session must reuse for new UI. This session touches presentation and locale plumbing only — no new business logic, no schema changes beyond the one field needed to remember a user's language.

---

## Deliverables & Acceptance Criteria

### D1 — Frontend i18n framework (Next.js App Router)

- Add and configure an i18n library for `apps/web` (see Tech Choices Guidance). Message catalogs: `apps/web/messages/en.json` and `apps/web/messages/pt-BR.json`.
- Replace every literal user-facing string in `apps/web/src/app/layout.tsx` (including `<title>`/metadata description), `apps/web/src/app/page.tsx`, `apps/web/src/app/wallet/page.tsx`, and `apps/web/src/components/ProtectedMedia.tsx` (including its `aria-label`s and the `role="status"` live-region announcement text) with a translation key.
- `apps/web/src/app/dev/protected-media/page.tsx` keeps its existing `notFound()` production gate unchanged; still externalize its strings for consistency in non-prod.
- **Acceptance criteria:** `pnpm --filter @creator-platform/web build` succeeds. A grep/lint check confirms no literal JSX text node longer than 3 words remains in the four in-scope files outside `messages/*.json`. `ProtectedMedia.test.tsx` gains a test asserting the live-region text is read from the active locale's catalog (assert on both `en` and `pt-BR` renders), not a hardcoded literal.

### D2 — Locale resolution & persistence (frontend)

- Resolution order: (1) an explicit cookie set by a language switcher, (2) the `Accept-Language` request header, (3) `NEXT_PUBLIC_DEFAULT_LOCALE` as the final fallback.
- Add a minimal EN/PT-BR switcher to the root layout that sets the cookie; the new locale must take effect on the next navigation without a full server restart.
- Document in this session's Notes/deviations whether routing is prefixed (`/en/...`, `/pt-BR/...`) or single-domain/cookie-only, and justify the choice against the existing unprefixed routes (`/`, `/wallet`, `/dev/protected-media`).
- **Acceptance criteria:** a test proves that setting the cookie changes rendered text on next navigation. A second test sends a request with `Accept-Language: pt-BR` and no cookie and asserts the **server-rendered** HTML payload is already in Portuguese (no client-side flash of the wrong language).

### D3 — `User.preferredLocale` + locale-aware transactional email

- Prisma migration adds `User.preferredLocale String @default("pt-BR")`. Valid values (`'pt-BR' | 'en'`) are enforced with Zod at every write path, not with a DB enum — avoids a second enum to migrate if a third locale is ever added.
- `POST /api/auth/register` accepts an optional `locale` field; invalid or missing falls back to `Accept-Language`, then `'pt-BR'`. Persist the resolved value as `preferredLocale`.
- New `PATCH /api/auth/me/locale` — `authenticate` (any role), body `{ locale: 'en' | 'pt-BR' }`, 200 on success, 400 on anything else (reject, never coerce silently). Rate-limited in line with the project's other authenticated write endpoints.
- `Emailer` (`apps/api/src/lib/email.ts`): `sendVerificationEmail` and `sendRenewalReminderEmail` gain a `locale` parameter. Full PT-BR **and** EN subject + body exist for both templates. `escapeHtml` is reused unchanged for every interpolated value in both locales — no localized template may skip escaping.
- Replace the manual `formatAmount` string-concatenation in `email.ts` with an `Intl.NumberFormat`-backed helper so the same `amountCents`/`currency` pair renders `R$ 29,90` in PT-BR and `$29.99` in EN.
- **Acceptance criteria:** an integration test creates a subscriber with `preferredLocale: 'pt-BR'`, drives the renewal-reminder path, and asserts the captured email is the Portuguese template with a comma-decimal amount. A second test does the same for `'en'`. The migration is **generated and applied** (per this project's convention — a generated-but-unapplied migration was flagged as a blocker in a prior session's Open Items; do not repeat that here).

### D4 — Localized shared product catalogs

- `SUBSCRIPTION_PLANS`, `CREDIT_PACKS`, and `GENERATION_PRESETS` in `packages/shared/src/index.ts` currently have a plain `label: string`. Make the label locale-aware (e.g. `label: Record<'en' | 'pt-BR', string>`, or a stable `labelKey` resolved through the same catalog mechanism as D1 — your choice, briefly justified) while `id`/`tier` remain the single stable, non-localized key every other module already joins on.
- Update every existing call site that reads `.label` as a plain string today, including `GenerationJob.userPrompt` persistence in `apps/api/src/modules/generation/generation.service.ts` (Session 08 stored the raw English preset label there verbatim). Decide and document whether `userPrompt` now stores a resolved-locale string or a stable canonical string with locale resolved only at display/audit time — this is a real behavior change and must be called out explicitly in Notes/deviations, not left implicit.
- **Acceptance criteria:** the full existing suite (payments, payouts, generation, and every other module) passes with **zero regressions**. Any assertion that legitimately needs to change because of the label shape change is updated with a one-line justification in this session's Notes/deviations — a silent test change is not acceptable.

### D5 — Locale-safe input handling

- Every entry point for a `locale` value (registration, `/me/locale`, the `Accept-Language` parser) validates against a hardcoded allowlist (`['en', 'pt-BR']`) via Zod. An unrecognized value is rejected or falls back to default — it is never reflected into a file path, a log format string, a header, or used to construct a dynamic import path from user input.

---

## Security Requirements

- `locale` input is allowlisted everywhere it is accepted; no dynamic string is used to build a require/import path, file path, or log line from an unvalidated locale value.
- `PATCH /api/auth/me/locale` requires `authenticate` and is rate-limited comparably to the project's other authenticated PATCH endpoints (e.g. cancel/resume in Session 06.5).
- `escapeHtml` continues to guard every interpolated value in **both** email locales — no exceptions for the new PT-BR template.
- No new secrets are introduced by this session; if any are, document them in the Environment Variables table exactly like every prior session did.

## Performance Requirements

- Message catalogs are code-split per locale on the frontend — only the active locale's JSON ships to the client on first load, not both.
- Resolving a catalog label (D4) is an in-memory lookup — no new DB query or network call is introduced on any hot path (checkout, generation, payout).

## Tech Choices Guidance

- Frontend: choose an i18n library for Next.js 14 App Router and briefly justify it (e.g. `next-intl` is the natural fit for App Router server components; if you choose differently, justify against it specifically).
- Backend: do **not** add a heavy i18n runtime dependency to `apps/api` for two email templates — a plain TypeScript `Record<locale, template>` map, consistent with how this codebase already handles small provider-keyed maps (e.g. `CHANNEL_CURRENCY`), is sufficient and preferred.
- Reuse the existing Zod-at-the-schema-layer validation pattern for the new `locale` fields — do not introduce a second validation approach.

## Out of Scope (do not implement this session)

- Lei FELCA / age verification (Session 09.5 — remains deferred).
- Admin dashboard (Session 11).
- Any new payment, payout, or generation business logic beyond making existing labels locale-aware.
- Localizing machine-readable API error codes (`insufficient_credits`, `ai_not_enabled`, etc.) — these remain stable codes; only human-facing surfaces (web UI + emails) are localized this session.

## Definition of Done

- [ ] All deliverables (D1–D5) implemented
- [ ] `en` and `pt-BR` message catalogs have full key parity (no key present in one and missing in the other)
- [ ] Migration for `User.preferredLocale` generated **and applied**
- [ ] Tests written and passing; `pnpm turbo run typecheck lint test build` and root `pnpm lint` all green, zero regressions across the existing suite
- [ ] No hardcoded secrets
- [ ] No user-facing literal string remains outside a message catalog in the in-scope web files and the two email templates
- [ ] `NEXT_PUBLIC_DEFAULT_LOCALE` documented in `.env.example` and wired as the final fallback
- [ ] Session security requirements met
- [ ] ARIA validation passed
