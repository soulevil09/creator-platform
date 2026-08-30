# Session 05 — Payments

## Context Recap (from CLAUDE.md)

- Sessions 01–04 are complete and verified: monorepo bootstrap, JWT auth + RBAC, model onboarding (reference images + AI consent/ToS), content upload/watermarking/tier-based access. 53 tests passing, all Turborepo tasks green.
- Payment stack is finalized: **Woovi/OpenPix** for Brazilian PIX (subscriptions + credit packs, CNPJ-backed MEI account linked to Nubank PJ, 0.80%/tx, no CPF collected from payer, immediate settlement), **NOWPayments** for crypto (subscriptions + credit packs, 0.5%/tx, 350+ currencies incl. USDT/USDC, native recurring billing, adult content explicitly permitted by ToS), and **CCBill** deferred post-MVP (scaffolded only as `MockPaymentProvider`, never called for real).
- Core architectural principle: every payment channel implements a shared `IPaymentProvider` interface; the active provider is selected via environment variable. Swapping adapters must never require changes to business logic.
- Stripe and all Brazilian mainstream processors (PagBank, Pagar.me, Mercado Pago, etc.) are permanently excluded — incompatible with adult content under card network policy. Do not reference or scaffold them.
- The real Woovi merchant account is pending final approval (landing page submitted, review in progress). This session must run **100% against mocked HTTP responses** in tests — no live credentials are required or expected to exist yet.

## Objective

Build the payments domain: subscription checkout, credit-pack checkout, the `IPaymentProvider` abstraction with three adapters (Woovi PIX, NOWPayments crypto, Mock/CCBill-deferred), webhook ingestion for both live providers, the credit wallet, and the `IPayoutProvider` interface contract (implementation deferred to Session 06).

This is a backend-heavy session (`apps/api`), with minimal frontend (a checkout trigger + wallet balance read is enough; full checkout UI can be refined later). Do not touch auth, onboarding, or content modules except to reference existing models (`User`, `ModelProfile`, `Content`, `ContentAccess`) as needed.

## Deliverables & Acceptance Criteria

### 1. Prisma schema — payments domain

Add to `apps/api/prisma/schema.prisma`:
- `Subscription` — subscriber ↔ model, tier, status (`ACTIVE`/`CANCELED`/`PAST_DUE`/`EXPIRED`), provider, `providerSubscriptionId`, `currentPeriodEnd`. Unique constraint on `(subscriberId, modelId)`.
- `CreditWallet` — one-to-one with `User`, integer `balance`, never negative.
- `PaymentTransaction` — `type` (`SUBSCRIPTION`/`CREDIT_PACK`), `provider` (`WOOVI`/`NOWPAYMENTS`/`CCBILL_MOCK`), `providerTransactionId`, `amount`, `currency`, `creditsGranted` (nullable), `status` (`PENDING`/`CONFIRMED`/`FAILED`), and a unique `idempotencyKey`.
- `AuditLog` — `actorId` (nullable, for system-triggered events), `action`, `entity`, `entityId`, `metadata` (Json), `createdAt`.
- **Acceptance:** `prisma migrate dev` runs clean; a unique constraint on `PaymentTransaction.idempotencyKey` exists and is enforced by a test that attempts a duplicate insert and expects a rejection.

### 2. `IPaymentProvider` interface + provider factory

File: `apps/api/src/modules/payments/provider.interface.ts`
- Methods: `createCharge(params): Promise<ChargeResult>` (covers both subscription and one-off credit-pack charges via a `kind` param), `verifyWebhookSignature(rawBody, headers): boolean`, `parseWebhookEvent(rawBody): NormalizedPaymentEvent`.
- A factory (`getPaymentProvider(channel: 'pix' | 'crypto' | 'card')`) reads `PAYMENT_PROVIDER_PIX`, `PAYMENT_PROVIDER_CRYPTO`, `PAYMENT_PROVIDER_CARD` env vars and returns the matching adapter instance.
- **Acceptance:** unit test instantiates the factory for all three channels and asserts the correct adapter class is returned; swapping the env var swaps the class with no other code change.

### 3. `WooviPixAdapter`

File: `apps/api/src/modules/payments/adapters/woovi.adapter.ts`
- Implements `IPaymentProvider` against the Woovi/OpenPix public charge + subscription API.
- `verifyWebhookSignature` validates the Woovi HMAC signature header; returns `false` on any mismatch (do not throw).
- All HTTP calls in tests go through mocked responses (`nock` or `msw` — Claude Code's choice, justify briefly). No real network calls in the test suite.
- **Acceptance:** `POST /api/payments/checkout/subscription` with `provider=pix` calls the adapter and returns a QR code payload + `copia e cola` string from the mocked response.

### 4. `NOWPaymentsAdapter`

File: `apps/api/src/modules/payments/adapters/nowpayments.adapter.ts`
- Implements `IPaymentProvider` against the NOWPayments payment + subscription (recurring) API.
- `verifyWebhookSignature` validates the NOWPayments IPN HMAC-SHA512 signature; returns `false` on mismatch.
- **Acceptance:** `POST /api/payments/checkout/credits` with `provider=crypto` calls the adapter and returns a payment address + amount from the mocked response.

### 5. `MockPaymentProvider` (CCBill slot)

File: `apps/api/src/modules/payments/adapters/mock.adapter.ts`
- Implements `IPaymentProvider` with deterministic, in-memory behavior (no HTTP calls at all) — used for the `card` channel until CCBill is activated post-MVP.
- **Acceptance:** selecting `PAYMENT_PROVIDER_CARD=mock` (the only valid value at MVP) routes card-channel checkout to this adapter; attempting to select any other value for `card` throws a clear configuration error at boot.

### 6. Checkout endpoints

- `POST /api/payments/checkout/subscription` — body: `{ modelId, tier, provider: 'pix' | 'crypto' }`. Creates a `PENDING` `PaymentTransaction`, calls the provider adapter, returns the charge payload to the client.
- `POST /api/payments/checkout/credits` — body: `{ packId, provider: 'pix' | 'crypto' }`. Same pattern, `type=CREDIT_PACK`.
- Both endpoints require an authenticated subscriber (reuse Session 02 JWT/RBAC middleware) and validate/sanitize all inputs.
- **Acceptance:** integration test for each endpoint: valid request → `PENDING` `PaymentTransaction` row created → adapter called with correct params → 201 response with charge payload.

### 7. Webhook endpoints

- `POST /api/payments/woovi/webhook` and `POST /api/payments/nowpayments/webhook`.
- Both: verify signature first (before touching the DB) → 400 on mismatch, no DB writes. On valid signature, parse the event and process idempotently using `idempotencyKey` (the provider's transaction ID) — a duplicate webhook delivery must not double-credit.
- On a confirmed `SUBSCRIPTION` event: mark `PaymentTransaction` `CONFIRMED`, upsert the `Subscription` row, grant `ContentAccess` for that tier (reuse the Session 04 access-granting logic).
- On a confirmed `CREDIT_PACK` event: mark `PaymentTransaction` `CONFIRMED`, increment the subscriber's `CreditWallet.balance` inside the same DB transaction as the status update.
- Write an `AuditLog` row for every confirmed financial event.
- **Acceptance (mirrors the CLAUDE.md example exactly):** integration test — mock webhook payload → `Subscription` row created → `ContentAccess` granted → 200 response. A second test sends the identical payload twice and asserts the wallet/subscription state changes only once.

### 8. Credit wallet service + read endpoint

File: `apps/api/src/modules/wallet/wallet.service.ts`
- `getBalance(userId)`, `addCredits(userId, amount, txContext)`, `debitCredits(userId, amount)` — the debit function must reject and throw a typed error on insufficient balance (it will be wired into AI generation in Session 08; write it generically now).
- `GET /api/wallet/balance` — authenticated, returns the caller's own balance only.
- **Acceptance:** unit tests cover `addCredits`, successful `debitCredits`, and `debitCredits` on an under-funded wallet (expects a rejection, no partial mutation).

### 9. `IPayoutProvider` interface (contract only)

File: `apps/api/src/modules/payouts/provider.interface.ts`
- Define the interface (`createPayout`, `verifyWebhookSignature`) that the Session 06 `PaxumAdapter` will implement. **Do not implement any adapter or Paxum HTTP calls in this session** — interface only, with a `// TODO(Session 06): implement PaxumAdapter` comment.
- **Acceptance:** file exists, compiles, exported from the module's index; no runtime behavior to test.

## Security Requirements

- All provider credentials (`OPENPIX_APP_ID`, `OPENPIX_WEBHOOK_SECRET`, `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`) read from env vars only; add placeholders to `.env.example` and `apps/api/.env.example` — never a real value in any committed file.
- Webhook signature verification must run **before** any database read or write.
- All checkout and wallet endpoints require authentication; checkout endpoints are subscriber-role only (reuse Session 02 RBAC).
- Rate limit checkout endpoints (a sensible per-user limit, e.g. 10 req/min) to prevent charge-spam.
- Every state-changing financial operation (charge created, webhook confirmed, wallet credited) writes an `AuditLog` row — no financial mutation without a corresponding audit entry.
- Idempotency is mandatory on webhook processing — enforced at the DB level via the unique `idempotencyKey` constraint, not just in application logic.

## Performance Requirements

- Webhook handlers must complete signature verification + DB transaction in a single synchronous request cycle (no background queue needed at MVP scale) — target well under 2s in the test environment.
- Wallet balance increments and subscription/access grants happen inside a single Prisma `$transaction` — no window where a transaction is `CONFIRMED` but the wallet/access grant hasn't happened yet.

## Tech Choices Guidance

Briefly justify: HTTP mocking library for adapter tests (`nock` vs `msw`), and how webhook idempotency is enforced (DB unique constraint vs. application-level check — prefer DB-level as the source of truth).

## Definition of Done

- [ ] All deliverables above implemented
- [ ] Full test suite passing, including the existing 53 tests from Sessions 01–04 (no regressions)
- [ ] No hardcoded secrets anywhere in the diff; `.env.example` files updated with placeholders only
- [ ] Webhook signature validation, idempotency, audit logging, and rate limiting all in place and covered by tests
- [ ] `pnpm turbo run typecheck lint test build` passes clean
- [ ] Changes committed as `feat(payments): Woovi PIX + NOWPayments crypto adapters, IPaymentProvider abstraction, webhooks, credit wallet — session 05`, pushed to `origin/main`
- [ ] ARIA validation passed
