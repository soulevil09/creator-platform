# Session 06 — Revenue Sharing & Paxum Payouts

## Context Recap (from CLAUDE.md)

- Sessions 01–05 complete: bootstrap, auth (JWT + RBAC), model onboarding, content
  management (watermarking, tiered access), payments (Woovi PIX + NOWPayments crypto,
  `IPaymentProvider` abstraction, webhooks, credit wallet). 109 tests green, zero
  regressions across sessions.
- `IPayoutProvider` contract already scaffolded in Session 05
  (`src/modules/payouts/provider.interface.ts`): `createPayout` / `verifyWebhookSignature`
  / `parseWebhookEvent`. No adapter yet — `// TODO(Session 06): implement PaxumAdapter`.
- Confirmed product decisions: **80/20 revenue split (model/platform)**, matching the
  OnlyFans/Fansly/Fanvue industry standard; **weekly payout cadence**, platform →
  each model's Paxum wallet; **minimum payout threshold R$50** (5000 centavos) — below
  that, balance rolls into the next week automatically.
- Paxum Business account is **not yet approved** (external prerequisite still open).
  Session 05 faced the identical situation with Woovi/NOWPayments and resolved it by
  building the adapter against publicly documented behavior, mocking all HTTP with
  `nock`, and flagging exact field names as an Open Item for live verification once
  the merchant account is approved. This session follows the same pattern for Paxum.

---

## Objective

Implement automated, weekly, revenue-shared payouts to models via Paxum, on top of the
`IPayoutProvider` contract from Session 05. Track what portion of each confirmed
subscription payment belongs to the model vs. the platform, expose a model's payable
balance, and let a scheduled job trigger the weekly payout run.

---

## ⚠️ Scope boundary — read before implementing

**Credit-pack revenue is out of scope for this session's payout calculation.** Credits
are a wallet-wide balance with no per-model attribution yet — that attribution is
created at AI-generation time in Session 08, which hasn't shipped. Model earnings in
this session are computed **only** from `PaymentTransaction` rows where
`type = 'SUBSCRIPTION'` and `status = 'CONFIRMED'`. Extending payouts to cover
AI-generation credit spend is explicit Session 08 follow-up work, once generation
events carry a `modelId`. Do not invent a credit-pack split in this session.

---

## Deliverables & Acceptance Criteria

### 1. Revenue-split persisted on `PaymentTransaction`

- Prisma migration adds nullable `modelId`, `modelShareCents`, `platformShareCents`
  to `PaymentTransaction`.
- Extend the **existing** Session-05 webhook-confirmation `$transaction` in
  `payments.service.ts` — for `SUBSCRIPTION` events only — to compute and persist the
  split using `REVENUE_SHARE_MODEL_PCT` (env, default `80`). Remainder-to-platform
  rounding (`platformShareCents = amountCents - modelShareCents`) so cents never leak.
  `CREDIT_PACK` transactions leave `modelId`/shares `null`.
- **Acceptance:** integration test fires a Woovi subscription webhook; the confirmed
  `PaymentTransaction` carries `modelShareCents = round(amountCents * 0.80)`. All
  existing Session 05 payments tests still pass unmodified.

### 2. `Payout` model + ledger-derived balance

- New Prisma models: `Payout` (`id`, `modelId`, `amountCents`, `currency`, `status`
  enum `PENDING|PROCESSING|COMPLETED|FAILED`, `provider`, `providerPayoutId`,
  `idempotencyKey` UNIQUE, `periodStart`, `periodEnd`, `createdAt`, `completedAt`,
  `failureReason`). Add nullable `payoutId` FK to `PaymentTransaction`.
- A model's **available balance is always a derived query** —
  `SUM(modelShareCents) WHERE modelId = X AND payoutId IS NULL` — never a separately
  mutable counter. This matches the ledger-over-counter philosophy already established
  in Session 05 (`debitCredits`, DB-enforced idempotency).
- `GET /api/payouts/balance` — `authenticate` + `authorize('model')`; returns only the
  caller's own balance (userId from JWT, never a query param).
- **Acceptance:** two confirmed subscription transactions for the same model sum
  correctly; a transaction already attached to a `Payout` is excluded from the balance.

### 3. `PaxumAdapter implements IPayoutProvider`

- Implements the Session-05 interface: `createPayout`, `verifyWebhookSignature`,
  `parseWebhookEvent`.
- **Live field names are unverifiable until the Business account is approved.** Build
  against Paxum's publicly documented mass-payout mechanics (Paxum-to-Paxum P2P
  transfer, IPN webhook confirmation) and mock all HTTP with `nock`, exactly as
  Session 05 did for Woovi/NOWPayments pre-approval. Log an Open Item flagging the
  exact request/response field and header names for live verification — do not present
  invented field names as confirmed fact in the CLAUDE.md update.
- `MockPayoutProvider implements IPayoutProvider` — deterministic, zero HTTP, mirrors
  `MockPaymentProvider`; used in tests and as `PAYOUT_PROVIDER=mock` for local dev.
- Extend `provider.factory.ts`: `getPayoutProvider()` reads `PAYOUT_PROVIDER` from env,
  throws `PayoutProviderConfigError` on an unrecognized value, validated eagerly at
  boot alongside the existing payment-provider check.

### 4. Weekly payout run

- `POST /api/payouts/run` — protected by a **service-secret header**
  (`X-Payout-Cron-Secret`, compared with `crypto.timingSafeEqual` against
  `PAYOUT_CRON_SECRET`), **not** a user JWT. This is called by a scheduled job, not a
  logged-in admin — there is no admin auth/dashboard yet (that's Session 11).
  - For every model with unpaid balance ≥ `PAYOUT_MIN_THRESHOLD_CENTS` (env, default
    `5000`): create a `PENDING` `Payout` inside a `$transaction` that also stamps
    `payoutId` onto every included `PaymentTransaction` via a conditional
    `updateMany` (compare-and-set — a retry mid-run can't double-include a row, same
    pattern as Session 05's webhook confirmation).
  - Call `PaxumAdapter.createPayout()`. Provider failure → `Payout.status = FAILED` +
    `AuditLog` entry + the attached transactions' `payoutId` rolled back to `null` so
    they're retried next run. No money silently stuck mid-state.
  - Models below threshold are simply skipped — their transactions keep
    `payoutId = null` and roll into next week automatically (no separate carry-over
    bookkeeping needed; it falls out of the balance query in #2).
  - Response: `{ processed, skipped, failed, totalCents }` — no per-model PII.
- `.github/workflows/weekly-payout.yml` — `cron: '0 12 * * 1'` (Monday, noon UTC),
  `curl -X POST $API_PUBLIC_URL/api/payouts/run -H "X-Payout-Cron-Secret: $PAYOUT_CRON_SECRET"`,
  secret sourced from GitHub Actions repo secrets.
- `POST /api/payouts/paxum/webhook` — Paxum IPN confirmation. Same raw-body-signature
  pattern as Session 05 (`request.rawBody`, verify before any DB access, 400 on
  mismatch); transitions `Payout.status` `PROCESSING → COMPLETED` or `→ FAILED`.
- **Acceptance:** integration test simulates a run with 3 models (2 above threshold,
  1 below) → 2 `Payout` rows created, `payoutId` correctly stamped, the third model's
  balance untouched. A second immediate run with no new transactions processes 0.

### 5. Minimal admin visibility (no UI — Session 11 owns the dashboard)

- `GET /api/payouts` — ADMIN-only, paginated list across all models.
- `GET /api/payouts/:payoutId` — ADMIN or the owning MODEL only.

---

## Security Requirements

- No Paxum credential, IPN secret, or cron secret ever appears in a response body,
  log line, or error message — same non-negotiable as `storageKey` in Session 04.
- `PAYOUT_CRON_SECRET` compared with `crypto.timingSafeEqual`, never `===`.
- `/api/payouts/run` rejects with 401 on a missing/wrong secret **before** touching
  the database.
- Every `Payout` status transition, and each run's summary, writes an `AuditLog` row
  (reuse the Session 05 model) — financial audit trail is mandatory, not optional.
- `GET /api/payouts/balance` and payout-detail endpoints scope strictly by JWT
  `userId`/role — a model must never read another model's balance or payout history.
- Rate-limit `/api/payouts/run` (e.g. 2/hour) — cron-only doesn't mean unguarded; a
  leaked secret shouldn't be able to trigger unlimited runs.

## Performance Requirements

- Add an index on `PaymentTransaction(modelId, payoutId)` in the migration — the
  balance-derivation query depends on it.
- Process models in the payout run in small batches (e.g. chunks of 10 via
  `Promise.allSettled`), not fully sequential or fully parallel, so one slow/failing
  Paxum call doesn't stall or overwhelm the whole run.

## Tech Choices Guidance

- Reuse `nock@14` for `PaxumAdapter` HTTP mocking (Session 05 precedent — don't
  introduce a second mocking library).
- Reuse the compare-and-set / single-`$transaction` idempotency pattern from Session 05
  rather than inventing a new one for payouts.
- Briefly justify the service-secret-header choice for `/payouts/run` over an admin
  JWT: a cron job has no user session to hold a JWT, and no admin auth exists yet.

---

## Definition of Done

- [ ] All 5 deliverables implemented
- [ ] Migration for `Payout` + `PaymentTransaction.{modelId,modelShareCents,platformShareCents,payoutId}`
      generated **and applied** to the live Supabase instance (confirm
      `npx prisma migrate deploy` succeeds — don't repeat the Session 05 situation)
- [ ] Tests written and passing; zero regressions on the existing 109
- [ ] No hardcoded secrets — `PAYOUT_CRON_SECRET`, `PAXUM_API_KEY`, `PAXUM_IPN_SECRET`
      added to `.env.example` (root + `apps/api`) as placeholders only
- [ ] Session security requirements met (timing-safe secret comparison, audit log on
      every state transition, strict per-user scoping)
- [ ] `.env.example` updated with `PAYOUT_PROVIDER`, `REVENUE_SHARE_MODEL_PCT`,
      `PAYOUT_MIN_THRESHOLD_CENTS`, `PAYOUT_CRON_SECRET`, `PAXUM_API_KEY`,
      `PAXUM_IPN_SECRET`
- [ ] ARIA validation passed
