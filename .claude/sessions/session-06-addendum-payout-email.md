# Session 06 — Addendum: `payoutEmail`

## Context Recap

- Session 06 (revenue sharing & Paxum payouts) is implemented and green (159 tests),
  migration applied to Supabase. One gap logged as an Open Item blocks any *real*
  payout from working: `PaxumAdapter` currently addresses recipients by the model's
  **platform login email** (`User.email`), but Paxum pays out to the email on the
  model's **personal Paxum account**, which may not match.
- This addendum closes that gap before the Session 06 commit. It is not a new session
  — same conversation, same Definition of Done it plugs into.

## Objective

Let a model set the email their Paxum account uses to receive funds, store it
separately from their login email, and make the payout run use it — failing safely
(skip, not crash) for any model who hasn't set one yet.

## Deliverables & Acceptance Criteria

### 1. Schema

- Add `payoutEmail String? @unique` to `ModelProfile` (small migration on top of
  `20260901120000_add_payouts`). `@unique` matters: two models pointing at the same
  Paxum email would misroute funds, and the DB should refuse that outright, not rely
  on application-layer checking alone.

### 2. `PUT /api/payouts/payout-email`

- `authenticate` + `authorize('model')`; the model's own `userId` from the JWT, no id
  in the body or path.
- Body: `{ payoutEmail: string }`. Validate as a real email format; reject with 400
  on malformed input.
- On success: update `ModelProfile.payoutEmail`, write an `AuditLog` entry recording
  that the payout destination changed (this field routes real money — every change is
  audit-worthy, same bar as the financial events from Session 05/06).
- Acceptance:
  - First-time set → 200, profile updated, `AuditLog` entry written.
  - Changing an existing value → 200, `AuditLog` entry written.
  - Malformed email → 400, nothing written.
  - Another model's or a subscriber's JWT → 403.
  - Unauthenticated → 401.
  - A second model attempting an email already claimed by another model → 409
    (unique constraint surfaced as a clean conflict, not a raw DB error).

### 3. Payout run reads `payoutEmail`, not login email

- `PaxumAdapter.createPayout` (and whatever builds its request in `payouts.service.ts`)
  must source the recipient address from `ModelProfile.payoutEmail`, never `User.email`.
- A model with unpaid balance ≥ threshold but `payoutEmail = null` is **skipped**, not
  failed — mirror the existing "account no longer exists" skip path exactly: nothing
  claimed, an audit entry (`payout.skipped_no_payout_email`) written, balance stays
  payable next run.
- Acceptance:
  - Update (or add alongside) the existing "pays models above threshold" test to
    assert the mocked Paxum HTTP call receives `payoutEmail`, not the login email.
  - New test: a model above threshold with no `payoutEmail` set is skipped, balance
    untouched, correct audit entry written.

### 4. Balance endpoint surfaces the gap

- `GET /api/payouts/balance` response gains `payoutEmailConfigured: boolean` so a
  future UI can prompt the model to set it before they expect to get paid.
- Acceptance: response reflects `true`/`false` correctly for both states.

## Security Requirements

- `payoutEmail` changes are authenticated, self-service only (a model can only ever
  write their own), and every change is audit-logged — this field is effectively
  "where does the money go," so treat it with the same care as a bank-detail change.
- No plaintext dump of `payoutEmail` in logs beyond the audit trail itself.

## Definition of Done

- [ ] Migration for `ModelProfile.payoutEmail` generated **and applied** to Supabase
- [ ] `PUT /api/payouts/payout-email` implemented with all acceptance criteria above
- [ ] Payout run reads `payoutEmail`, skips (not fails) models without one
- [ ] `GET /api/payouts/balance` returns `payoutEmailConfigured`
- [ ] New/updated tests passing, zero regressions on the existing 159
- [ ] CLAUDE.md Open Items: the `payoutEmail` gap entry updated to reflect resolution
- [ ] ARIA validation passed
