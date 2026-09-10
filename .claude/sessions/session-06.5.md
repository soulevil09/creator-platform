# Session 06.5 — Subscription Lifecycle: Renewal & Cancellation

## Context Recap (from CLAUDE.md)

- Sessions 01–06 complete (including the Session 06 `payoutEmail` addendum). 176 tests
  green. Payments (Session 05) and payouts (Session 06) both live.
- `SubscriptionStatus` enum (`ACTIVE|CANCELED|PAST_DUE|EXPIRED`) already exists on
  `Subscription` but nothing besides the initial `ACTIVE` write ever sets it.
- The webhook confirmation path already does `subscription.upsert` keyed on
  `(subscriberId, modelId)` — paying a new `SUBSCRIPTION` charge for a pair that
  already has a row **already** reactivates it and pushes `currentPeriodEnd`
  forward, regardless of its current status. This session does not need to touch
  that upsert.
- `ContentAccess.expiresAt` is already checked live at serve-time ("valid when it
  has no expiry or expires in the future") — access already cuts off on its own
  once `currentPeriodEnd`/`expiresAt` passes. This session does not need to add
  access revocation logic.
- Decision confirmed with Igor: **manual renewal via a fresh one-time charge**
  (reminder + grace period), not Woovi's Pix Automático (BACEN recurring mandate).
  Pix Automático is a strong future upgrade for PIX subscribers specifically but is
  a separate, larger retrofit — tracked as a future candidate, not built here. This
  session's design must work identically for PIX and crypto through the existing
  `IPaymentProvider` abstraction.

## Objective

Automatically generate a renewal charge before a subscription's `currentPeriodEnd`,
notify the subscriber, give a short grace period if they don't pay in time, and let a
subscriber cancel (access continues through what they already paid for, then it does
not renew). Keep `Subscription.status` an honest reflection of reality for admin/model
reporting — access enforcement itself already works without it.

## New module: `modules/subscriptions/`

Give this its own module rather than growing `payments.service.ts` further — same
reasoning Session 06 used to keep `payouts/` separate from `payments/`: this is a
distinct concern (lifecycle orchestration) from single-charge processing, and mixing
them makes both harder to reason about.

## Deliverables & Acceptance Criteria

### 1. Schema

- Add `cancelAtPeriodEnd Boolean @default(false)` to `Subscription`. This is the one
  new column: it keeps `status` meaning "current access state" and separately tracks
  "will this renew." A subscriber who cancels stays `ACTIVE` (they keep what they
  paid for) with `cancelAtPeriodEnd: true`; the renewal sweep skips generating a
  charge for them and, at `currentPeriodEnd`, they go straight to `CANCELED` — never
  `PAST_DUE`, since there is nothing to retry for someone who opted out. A lapsed
  non-payer (`cancelAtPeriodEnd: false`) goes `ACTIVE → PAST_DUE → EXPIRED` instead.
  This distinction is deliberate: churn (`CANCELED`) and payment failure (`EXPIRED`)
  are different business signals and should stay queryable as such.

### 2. Shared renewal-charge issuance

- Extract the charge-creation logic already used by
  `POST /api/payments/checkout/subscription` into a function callable from both the
  public endpoint and the internal renewal sweep (e.g.
  `issueSubscriptionCharge(subscriberId, modelId, tier)` in the payments module) —
  do not duplicate the `IPaymentProvider` call site.
- Acceptance: the existing `POST /api/payments/checkout/subscription` tests still
  pass unmodified, now calling through the shared function.

### 3. `POST /api/subscriptions/renewals/run`

- Protected the same way as `POST /api/payouts/run` — `X-Renewal-Cron-Secret`
  compared with `crypto.timingSafeEqual` against `SUBSCRIPTION_RENEWAL_CRON_SECRET`,
  not a user JWT, 401 before any DB access, rate-limited (e.g. 4/hour — this one may
  legitimately need a retry within the same day, unlike the weekly payout run).
- One idempotent run does, in order:
  1. **Issue reminders.** For every `Subscription` with `status: ACTIVE`,
     `cancelAtPeriodEnd: false`, and `currentPeriodEnd` within
     `SUBSCRIPTION_RENEWAL_REMINDER_DAYS` (env, default `3`) of now — skip if a
     `PENDING` `SUBSCRIPTION`-type `PaymentTransaction` for that
     `(subscriberId, modelId)` pair already exists (no double-charging on a second
     run the same day); otherwise call `issueSubscriptionCharge` and send a renewal
     reminder using whatever transactional-email capability already exists from the
     auth module's verification email.
  2. **Grace period start.** `status: ACTIVE`, `cancelAtPeriodEnd: false`,
     `currentPeriodEnd < now` → `status: PAST_DUE`. Audit-logged. (Their existing
     `ContentAccess` has already expired on its own by this point — this step is
     bookkeeping, not access control.)
  3. **Grace period end.** `status: PAST_DUE`,
     `currentPeriodEnd + SUBSCRIPTION_GRACE_PERIOD_DAYS (env, default 3) < now` →
     `status: EXPIRED`. Audit-logged.
  4. **Cancellations landing.** `status: ACTIVE`, `cancelAtPeriodEnd: true`,
     `currentPeriodEnd < now` → `status: CANCELED`. Audit-logged.
- Response: `{ remindersIssued, movedToPastDue, movedToExpired, movedToCanceled }` —
  aggregates only, same reasoning as the payout run's response.
- `.github/workflows/subscription-renewals.yml` — daily cron (e.g. `0 6 * * *`),
  same shape as `weekly-payout.yml`.
- Acceptance:
  - A subscription 2 days from `currentPeriodEnd` gets a renewal charge issued once;
    a second run the same day issues nothing more for it.
  - A subscription already past `currentPeriodEnd` with no payment moves to
    `PAST_DUE`; run again immediately → no-op (already `PAST_DUE`).
  - A `PAST_DUE` subscription past its grace window moves to `EXPIRED`.
  - A subscription with `cancelAtPeriodEnd: true` gets no reminder charge and, once
    past `currentPeriodEnd`, moves straight to `CANCELED`, never `PAST_DUE`.
  - Paying the reminder charge (simulate the existing webhook confirmation) reactivates
    a `PAST_DUE` subscription to `ACTIVE` with a fresh `currentPeriodEnd` — this
    already works via the Session 05 upsert; write the test to prove the seam holds
    rather than to add new code.

### 4. Subscriber-facing endpoints

- `GET /api/subscriptions/me` — `authenticate` + `authorize('subscriber')`; the
  caller's own subscriptions (`tier`, `status`, `currentPeriodEnd`,
  `cancelAtPeriodEnd`), scoped by JWT `userId`.
- `POST /api/subscriptions/model/:modelId/cancel` — sets `cancelAtPeriodEnd: true` on
  the caller's subscription to that model. 404 if no subscription exists for the
  pair. Audit-logged (a cancellation intent is worth a trail). Idempotent — canceling
  an already-canceling subscription is a 200 no-op, not an error.
- `POST /api/subscriptions/model/:modelId/resume` — flips `cancelAtPeriodEnd` back to
  `false`, only while `status: ACTIVE` (a subscriber who changed their mind before
  the period actually ended). 409 if the subscription has already moved past `ACTIVE`
  (`PAST_DUE`/`EXPIRED`/`CANCELED`) — at that point they resubscribe through the
  normal checkout, which is a simpler mental model than trying to resurrect a lapsed
  row.
- Acceptance: standard auth/ownership matrix (401 unauthenticated, 403 wrong role,
  404 another subscriber's or a nonexistent subscription never leaks existence
  details beyond 404) plus the cancel → resume → still-active round trip.

## Security Requirements

- `SUBSCRIPTION_RENEWAL_CRON_SECRET` never appears in a response, log line, or error
  message; timing-safe comparison, same bar as `PAYOUT_CRON_SECRET`.
- Every `Subscription.status` transition and every cancel/resume action writes an
  `AuditLog` row.
- `GET /api/subscriptions/me` and the cancel/resume endpoints scope strictly to the
  caller's own `userId` — no id substitution possible.

## Performance Requirements

- The renewal sweep's queries (`status`, `cancelAtPeriodEnd`, `currentPeriodEnd`) need
  a composite index — add `@@index([status, cancelAtPeriodEnd, currentPeriodEnd])` on
  `Subscription` in the migration.

## Tech Choices Guidance

- Reuse the compare-and-set-free but idempotent-by-query pattern already established
  (checking for an existing `PENDING` transaction before creating a new one) rather
  than inventing new claim machinery — this job doesn't move money by itself, it only
  issues charges, so it doesn't need the payout run's claim/rollback complexity.
- Briefly justify the `cancelAtPeriodEnd` boolean over adding a fifth `status` value:
  it keeps `status` meaning one thing (current access state) instead of overloading
  it with "will renew" as well.

## Definition of Done

- [ ] All 4 deliverables implemented
- [ ] Migration for `Subscription.cancelAtPeriodEnd` + composite index generated
      **and applied** to the live Supabase instance
- [ ] Tests written and passing, zero regressions on the existing 176
- [ ] No hardcoded secrets — `SUBSCRIPTION_RENEWAL_CRON_SECRET`,
      `SUBSCRIPTION_RENEWAL_REMINDER_DAYS`, `SUBSCRIPTION_GRACE_PERIOD_DAYS` added to
      `.env.example` (root + `apps/api`)
- [ ] Session security requirements met
- [ ] CLAUDE.md updated: Session 06.5 marked complete, Session 07 confirmed next,
      Pix Automático logged as an explicit future candidate (not a blocker)
- [ ] ARIA validation passed
