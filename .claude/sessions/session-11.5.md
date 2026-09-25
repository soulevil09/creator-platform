# Session 11.5 — Hotfix: Per-User Rate Limits Were Silently Keying on IP

## Context Recap (from CLAUDE.md / Session 11 findings)

- While building the Session 11 admin console, the implementation noticed that `config.rateLimit` (the route-option form `@fastify/rate-limit` reads) attaches its check as an **`onRequest`** hook, which Fastify runs **before** any route `preHandler` — including `authenticate`. Every `keyGenerator: (request) => request.user?.userId ?? request.ip` written against `config.rateLimit` therefore always sees `request.user` as `undefined` and silently falls through to `request.ip`, no matter how the route's `preHandler` is written.
- Session 11 fixed this correctly for its **own** new routes (`/api/admin/*`, `POST /api/content/:contentId/report`) using a different attachment form: `preHandler: [authenticate, app.rateLimit(RATE_LIMIT_CONST)]`, which runs the rate check *after* `authenticate` has set `request.user`. That pattern is proven in this codebase (`admin.test.ts`, the report-route test) — this session applies the exact same fix to the pre-existing occurrences, changing nothing else.
- I (ARIA) independently confirmed the exact scope by grepping the committed source for the `request.user?.userId ?? request.ip` keyGenerator pattern combined with `config: { rateLimit`. Five files are affected:
  - `apps/api/src/modules/auth/auth.routes.ts` — `AUTHENTICATED_WRITE_RATE_LIMIT` (20/hour), on `PATCH /api/auth/me/locale` (Session 10).
  - `apps/api/src/modules/payments/payments.routes.ts` — `CHECKOUT_RATE_LIMIT` (10/min), on `POST /api/payments/checkout/subscription` and `/checkout/credits` (Session 05) — **the highest-priority fix**: this is the one guarding money-movement endpoints, and its own doc comment says the intent is exactly to stop one account from spamming checkout across multiple IPs, which is precisely what isn't happening today.
  - `apps/api/src/modules/messaging/messaging.routes.ts` — `SEND_RATE_LIMIT` (60/min) and `READ_RATE_LIMIT` (120/min), across 6 route registrations (Session 07).
  - `apps/api/src/modules/generation/generation.routes.ts` — `CREATE_RATE_LIMIT` (10/hour), on `POST /api/generations` (Session 08) — gates AI-generation spend.
  - `apps/api/src/modules/subscriptions/subscriptions.routes.ts` — `WRITE_RATE_LIMIT` (20/hour), on the cancel/resume endpoints (Session 06.5).
- **Not in scope / not affected** — verified, do not touch: the auth module's pre-authentication limits (register, login — IP is the only correct key before a user exists); `content.routes.ts` upload, `onboarding.routes.ts`, `wallet.routes.ts`, `payouts.routes.ts`, and `subscriptions.routes.ts`'s `READ_RATE_LIMIT` — none of these declare a per-user `keyGenerator`, so none of them silently downgraded to anything; they were designed as IP-scoped and still are.

**Out of scope for this session:** any change to the *values* of these rate limits (max/window), any new endpoint, and any of the four items already deferred from Session 11 to Session 12. This is a mechanical fix to how five existing limits are wired, nothing else.

---

## Objective

Make every rate limit that was designed to be per-user actually be per-user, using the one attachment pattern this codebase already trusts (`app.rateLimit()` as a post-`authenticate` `preHandler`), with a test on each fixed route proving the budget now survives an IP change and is shared correctly within one account.

---

## Deliverables & Acceptance Criteria

### D1 — `auth.routes.ts`: `PATCH /api/auth/me/locale`

- Change the route's rate-limit attachment from `{ preHandler: authenticate, config: { rateLimit: AUTHENTICATED_WRITE_RATE_LIMIT } }` to `{ preHandler: [authenticate, app.rateLimit(AUTHENTICATED_WRITE_RATE_LIMIT)] }` (or the module's existing equivalent helper if one exists after D2–D5 introduce one — see Tech Choices Guidance). No other line in this route changes.
- **Acceptance:** a test authenticates as one user, exhausts the 20/hour budget, confirms the 21st call is 429, then shows a **second account** issuing the request from the same client/IP is not blocked; and shows the **same account** switching IP (a fresh `app.inject` call with a different `x-forwarded-for` or equivalent, matching however the test harness varies IP in the existing suite) is still blocked.

### D2 — `payments.routes.ts`: checkout endpoints (highest priority)

- Apply the same fix to both `POST /api/payments/checkout/subscription` and `POST /api/payments/checkout/credits` (`CHECKOUT_RATE_LIMIT`, 10/min).
- **Acceptance:** same three-part test shape as D1, run against both endpoints (may share a test helper) — exhausting the budget as one subscriber, a 429 on the 11th call within the window, an unaffected second account behind the same IP, and a persisting block for the same account behind a different IP.

### D3 — `messaging.routes.ts`: all six route registrations

- Apply the fix everywhere `SEND_RATE_LIMIT` or `READ_RATE_LIMIT` is attached via `config.rateLimit` (conversation creation, message history, send message, attachment URL, read receipt — whichever of the six carry these two consts).
- **Acceptance:** one test per const (not necessarily per route) is enough — proving `SEND_RATE_LIMIT` and `READ_RATE_LIMIT` are each genuinely per-user on at least one representative endpoint that uses them, using the same three-part shape.

### D4 — `generation.routes.ts`: `POST /api/generations`

- Apply the fix to `CREATE_RATE_LIMIT` (10/hour) on the generation-creation endpoint.
- **Acceptance:** same three-part test shape as D1/D2.

### D5 — `subscriptions.routes.ts`: cancel/resume endpoints

- Apply the fix to `WRITE_RATE_LIMIT` (20/hour) on `POST /model/:modelId/cancel` and `/resume`. Leave `READ_RATE_LIMIT` (`GET /me`) untouched — it was never claimed to be per-user and isn't part of this bug.
- **Acceptance:** same three-part test shape.

---

## Security Requirements

- No route's effective rate-limit *value* changes — this session corrects the key, not the budget.
- No route loses its rate limit entirely at any point during the fix (verify by running the full suite after each file, not only at the end) — a checkout endpoint with no active rate limit, even briefly in a broken intermediate commit, is not acceptable on a payment-grade platform.
- Do not touch `content.routes.ts`, `onboarding.routes.ts`, `wallet.routes.ts`, `payouts.routes.ts`, or `subscriptions.ts`'s `READ_RATE_LIMIT` — they are correctly IP-scoped today and are out of scope.

## Performance Requirements

- None beyond the existing rate-limit overhead — this is a hook-ordering fix, not a new check.

## Tech Choices Guidance

- Reuse `app.rateLimit(CONST)` exactly as Session 11 introduced it in `admin.routes.ts` and the content module's report route — do not invent a second pattern. If the repetition across five files is ugly enough to justify one, a tiny shared helper (e.g. `withUserRateLimit(app, limit)` returning the two-element `preHandler` array) may be introduced in a shared middleware location — briefly justify the choice either way in the session summary, same bar as every other "briefly justify" decision in this project.

---

## Definition of Done

- [ ] D1–D5 implemented — every listed const now attached via a post-`authenticate` `preHandler`, nothing else changed
- [ ] One test per fixed const proving per-user (not per-IP) behavior, using the three-part shape (own-account exhaustion → 429, other-account-same-IP unaffected, same-account-different-IP still blocked)
- [ ] Full existing suite still green — zero regressions, and no route observed with its rate limit silently absent mid-fix
- [ ] No hardcoded secrets; no rate-limit value changed
- [ ] `pnpm turbo run typecheck lint test build` green
- [ ] CLAUDE.md updated: this hotfix logged under its own entry (mirroring the Session 06.5 / addendum format), and the corresponding line in Session 11's write-up ("logged as a Session 12 Open Item") updated to point here instead
