# Session 11 — Admin Dashboard

## Context Recap (from CLAUDE.md)

- RBAC has three roles (`ADMIN`, `MODEL`, `SUBSCRIBER`); `ADMIN` is provisioned out-of-band, never via public registration. `authorize('admin')` already guards `GET /api/payouts` and `GET /api/payouts/:payoutId` (Session 06) — reuse that exact pattern, do not invent a new admin-check mechanism.
- **There is currently no model-approval workflow.** `User.isVerified` is set only by clicking the email-verification link (Session 02) and is then reused as the sole gate for content upload (`content.service.ts`) and subscription checkout (`payments.service.ts`). In other words, any model with a verified email can upload content and accept paying subscribers today — nothing in the platform reflects a human decision to approve a model. This session introduces that decision as its own concept, separate from email verification.
- Content moderation has no admin lever short of hard delete: `PATCH /:contentId/publish` is `authorize('model')` only (owner toggles their own content); `DELETE /:contentId` is the only `authorize('model', 'admin')` route in the content module (Session 04/09), and it is a soft-delete. There is no way for an admin to unpublish someone else's content, and no reporting mechanism for subscribers to flag it in the first place.
- `apps/web` has no admin-facing UI at all — only `/`, `/wallet`, and the Session 09 dev demo route.
- Several Open Items are explicitly flagged as "candidate: Session 11" (FX-aware payout balances, crediting model earnings from credit-pack spend, a `Payout`/renewal reconciliation sweeper, stale `PENDING GenerationJob` cleanup). **Deliberately deferred to Session 12** (Security Hardening & Performance Audit, which already owns the index/reconciliation review) to keep this session to its named domain — metrics, user management, model approval, payout oversight, moderation — rather than also redesigning the payout money-math. Do not implement any of those four in this session; note them as still-open when updating CLAUDE.md.

---

## Objective

Give an ADMIN a working console: see the platform's vital signs at a glance, manage user accounts, approve or reject models before they can monetize, oversee payouts, and act on reported/abusive content — all behind the existing RBAC, with every state-changing action audited exactly like Sessions 05/06 do for money movement.

---

## Deliverables & Acceptance Criteria

### D1 — Model approval workflow

- Add `ModelApprovalStatus` enum (`PENDING | APPROVED | REJECTED`) and `ModelProfile.approvalStatus ModelApprovalStatus @default(PENDING)`, plus `approvalReviewedAt DateTime?` and `approvalRejectionReason String?`. Migration generated and applied.
- **Gate content upload and subscription/credit checkout on `approvalStatus === 'APPROVED'`, in addition to (not instead of) the existing `isVerified` check.** A model who is email-verified but not yet approved gets the same 403 shape the code already uses for the unverified case — do not silently change the error contract, add a distinct machine code (e.g. `model_not_approved`).
- `GET /api/admin/models?status=pending` (default `pending`, also accepts `approved`/`rejected`/`all`) — paginated, returns profile + short-TTL signed URLs for that model's reference images (reuse the existing signed-URL presigner, same TTL discipline as Session 03's `GET /onboarding/profile`) so an admin can actually look at what they're approving.
- `POST /api/admin/models/:userId/approve` — sets `APPROVED`, stamps `approvalReviewedAt`, writes an `AuditLog` row (`model.approved`). Idempotent: approving an already-approved model is a 200 no-op, no duplicate audit row.
- `POST /api/admin/models/:userId/reject` — body requires a non-empty `reason` (400 without one), sets `REJECTED` + `approvalRejectionReason`, audited (`model.rejected`, reason included). A rejected model can be moved back to `PENDING` by resubmitting their profile (out of scope to design that resubmission UX here — just don't make `REJECTED` a dead end at the data level: `approve` must work from any prior status).
- **Acceptance:** an integration test proves a `PENDING` model's upload attempt is rejected with `model_not_approved` before approval and succeeds immediately after `POST /approve`, with no other change to the request; a non-admin calling any `/api/admin/*` route gets 403; an unknown `userId` gets 404, not 500.

### D2 — User management

- `GET /api/admin/users` — paginated, filterable by `role` and a case-insensitive `email` substring search, returns `{ id, email, role, isVerified, displayName, createdAt }` — never `passwordHash`/`refreshTokenHash`.
- `GET /api/admin/users/:userId` — full detail: the above plus, when `role === 'MODEL'`, the `ModelProfile` approval status; when `role === 'SUBSCRIBER'`, active-subscription and wallet-balance counts (read-only rollups, no new write path).
- Add `User.suspendedAt DateTime?`. `POST /api/admin/users/:userId/suspend` (body: optional `reason`) and `POST /api/admin/users/:userId/reinstate` — audited (`user.suspended` / `user.reinstated`). `authenticate` must reject a suspended user's login and any refresh with 403 (`account_suspended`) — wire this into the existing login/refresh checks in `auth.service.ts`, do not duplicate the check ad hoc elsewhere.
- **An admin can never suspend another ADMIN through this endpoint** (403) — prevents a compromised or malicious admin session from locking out the rest of the admin team.
- **Acceptance:** a suspended user's existing session cannot refresh and a fresh login attempt is rejected with `account_suspended`; reinstating clears the block immediately; attempting to suspend a `role: ADMIN` user returns 403 and writes no audit row.

### D3 — Metrics overview

- `GET /api/admin/metrics/overview` — a single aggregate response computed with `groupBy`/`count`/`sum` queries (no loading full tables into memory, no N+1 — mirror the Session 07 "3 queries regardless of conversation count" discipline):
  - Active subscriber count and active-subscription count by tier.
  - Estimated recurring revenue: sum of active subscriptions' plan price, grouped by currency (explicitly labeled per-currency in the response — **do not sum across currencies**, since there is no FX policy yet; that gap is the deferred Open Item, not this session's to solve).
  - Credit-pack revenue confirmed in the last 30 days (sum of `PaymentTransaction.amount` where `type = CREDIT_PACK, status = CONFIRMED`), by currency.
  - Generation job volume and completion rate (`COMPLETED` / `FAILED` / `PENDING` counts) over the last 30 days.
  - Payout totals: sum `PENDING`/`PROCESSING`/`COMPLETED` `Payout.amount`, and count of models above the payout threshold with `payoutEmailConfigured: false` (directly surfaces the "skipped, no destination" case from Session 06's addendum).
- **Acceptance:** the endpoint responds in a bounded number of queries (assert via a query-count test, same technique as Session 07's messaging tests) regardless of how many users/transactions exist; multi-currency figures are never silently summed together.

### D4 — Payout oversight (admin-facing, reusing Session 06)

- `GET /api/payouts` and `GET /api/payouts/:payoutId` already exist and are `authorize('admin')` — the dashboard consumes them as-is; do not duplicate this logic.
- **Refactor** the existing cron-secret-guarded `POST /api/payouts/run` so its core logic (grouping, threshold, chunked `Promise.allSettled` claim-and-run) lives in one shared service function called by *two* entry points: the existing header-secret route (for the GitHub Actions cron) and a new `POST /api/admin/payouts/run` guarded by `authenticate` + `authorize('admin')` (for a manual on-demand run from the dashboard). Same rate limit discipline as the existing route; both routes' invocations are audited identically (the audit row records which entry point triggered the run).
- **Acceptance:** a test proves both routes drive the identical underlying function (e.g. by asserting identical side effects for equivalent input), and that the new admin route rejects a non-admin with 403 without touching any `Payout`/`PaymentTransaction` row.

### D5 — Content moderation

- `Report` model: `id, contentId, reporterId, reason (enum: SPAM | ILLEGAL | NON_CONSENSUAL | OTHER), details String?, status (PENDING | RESOLVED | DISMISSED), resolvedAction String?, createdAt, resolvedAt`. Migration generated and applied. Index on `(status, createdAt)`.
- `POST /api/content/:contentId/report` — any authenticated user (not just subscribers with access — an unauthorized viewer attempting to view gated content isn't the concern here; anyone who can see a thumbnail/listing can report it), rate-limited (e.g. 10/hour/user) to prevent report-flooding as harassment. One `PENDING` report per `(contentId, reporterId)` pair (DB unique constraint, same "let the database decide" discipline as Session 05/06/08's unique keys) — a repeat report from the same reporter on the same still-pending report is a 200 no-op, not a duplicate row.
- **Extend `PATCH /api/content/:contentId/publish` to accept `admin` in addition to `model`** (the route currently has no admin path at all), with the ownership check bypassed specifically for admins — this is the moderation unpublish lever that does not exist today.
- `GET /api/admin/reports?status=pending` — paginated, joins the reported content's owner/model for context.
- `POST /api/admin/reports/:reportId/resolve` — body: `{ action: 'none' | 'unpublish' | 'unpublish_and_suspend_model' }`. `unpublish` calls the content service's publish-toggle path (not a second, parallel unpublish implementation); `unpublish_and_suspend_model` additionally suspends the content owner via the D2 suspend path. Sets `status: RESOLVED`, `resolvedAction`, `resolvedAt`, audited (`report.resolved`, action + reportId + contentId).
- **Acceptance:** a subscriber can report a piece of content exactly once while it's pending (a second attempt while still pending is a no-op, not a second row); resolving with `unpublish` actually flips `Content.isPublished` to `false` through the existing service function; resolving with `unpublish_and_suspend_model` additionally blocks that model's next login.

### D6 — Admin dashboard UI (`apps/web`)

- New route group `apps/web/src/app/admin/` (a real page, not another `/dev/*` demo — this is the first genuinely admin-facing page in the app): overview metrics (D3), a pending-models approval queue (D1) with reference-image previews and approve/reject actions, a users table with search + suspend/reinstate (D2), a payouts list with a manual "run now" button (D4), and a pending-reports queue with resolve actions (D5).
- Client-side gating: redirect non-admins away from `/admin/*` — this is a UX convenience only, **the server-side `authorize('admin')` check on every endpoint is the actual security boundary** and must not be weakened or bypassed for the sake of the UI.
- Every destructive/state-changing action (approve/reject, suspend/reinstate, manual payout run, resolve report) requires an explicit confirmation step in the UI before firing.
- **Acceptance:** `eslint-plugin-jsx-a11y` (already active in CI since Session 05) passes with zero findings against the new admin pages, same bar as every prior web addition.

---

## Security Requirements

- Every `/api/admin/*` route and every admin-only action on an existing route (`PATCH /:contentId/publish` for admins, `POST /api/admin/payouts/run`) is `authenticate` + `authorize('admin')` — no route relies on the client hiding a button.
- An admin can never suspend or otherwise act against another `ADMIN` account through these endpoints (D2).
- All new mutating admin actions are written to `AuditLog` with enough detail to answer "who did what, to whom, when, why" — matching the bar Session 06 set for `payoutEmail` changes.
- `reason`/`details` free-text fields (rejection reason, report details) are stored and ever rendered through the existing HTML-escaping discipline — no raw interpolation into email or any future admin-facing HTML.
- Signed URLs surfaced to admins for reference-image review use the same short TTL as every other signed URL in the codebase (Sessions 03/04/07) — never a long-lived or permanent link.

## Performance Requirements

- `GET /api/admin/metrics/overview` uses aggregate DB queries only — verify with a query-count test, not by eyeballing the code (Session 07 precedent).
- `GET /api/admin/users` and `GET /api/admin/models` are paginated with a sane default/max page size (mirror Session 06's `GET /api/payouts` pagination) — never an unbounded `findMany`.

## Tech Choices Guidance

- No new runtime dependency should be needed for D1–D5 (Prisma, existing Zod/Fastify patterns cover it). If a UI table/pagination library is introduced for D6, justify it briefly against hand-rolling it, same bar as every prior "briefly justify" tech choice in this project.

---

## Definition of Done

- [ ] All deliverables (D1–D6) implemented
- [ ] Tests written and passing, including the D3/D4 query-count assertions and the D1/D2/D5 audit-trail assertions
- [ ] No hardcoded secrets
- [ ] Session security requirements met (admin-only enforcement, audit coverage, no plaintext leakage of reference images or rejection/report text)
- [ ] `pnpm turbo run typecheck lint test build` green, zero regressions across all 349+ existing API tests and 33+ web tests
- [ ] ARIA validation passed (jsx-a11y clean on the new admin UI; ownership/RBAC boundaries verified by test, not inspection)
