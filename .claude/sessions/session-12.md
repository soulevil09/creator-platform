# Session 12 — Security Hardening & Performance Audit

## Context Recap (from CLAUDE.md)

- Sessions 01–11.5 are complete: auth (JWT in httpOnly cookies + RBAC), onboarding, content (signed URLs, on-the-fly watermarking), payments (Woovi PIX + NOWPayments behind `IPaymentProvider`), payouts (Paxum behind `IPayoutProvider`), subscription lifecycle, real-time messaging, AI generation (Replicate/PhotoMaker behind `IAIProvider`), anti-leak tracing, i18n (PT-BR/EN), and the admin console. 13 migrations are live on Supabase; last reported totals are 381 API / 39 web / 6 shared tests.
- Session 11.5 fixed per-user rate limits: `config.rateLimit` runs at `onRequest` (before `authenticate`), so every per-user limit is now `app.rateLimit(CONST)` in a `preHandler` placed **after** `authenticate` (and after `authorize(...)` where one exists). That is the only pattern to use for per-user limits in this session.
- `@fastify/rate-limit` is registered with `global: false` and the default **in-memory** store. There is no `trustProxy` setting, no security-header plugin, no global error handler, and no explicit `bodyLimit` in `apps/api/src/index.ts`. `apps/web/next.config.mjs` sets no security headers.
- **ARIA pre-session finding:** `pnpm-lock.yaml` was last committed in Session 09. Session 10 added `next-intl` and `zod` to `apps/web/package.json` without committing the lockfile, so `pnpm install --frozen-lockfile` (what CI runs) fails. CI has been red for every commit since `64e86bd`. This must be fixed **before** this session starts (see D0).
- Open Items explicitly pointed at this session: stale `PENDING` `GenerationJob` after a crash (subscriber locked out, credits gone); `PROCESSING` payouts whose IPN never arrives; the unindexed forensic lookup `AuditLog.metadata->>'traceCode'`.

**Out of scope for this session:**
- FX-aware payouts and sharing credit-pack spend with models. Both are money features that need product decisions (FX policy; the model's share of a credit spend). They move to a separate session (12.5) once those decisions are made.
- A Redis-backed rate-limit store and cross-instance messaging pub/sub. Both only matter with more than one API instance, so they go to Session 13 (deployment). No new external account in this session.
- Lei FELCA (Session 09.5, deferred), frontend auth UI, locked-teaser listing, Pix Automático, the `Report.DISMISSED` write path.
- Any change to an existing rate-limit **value** or to any payment/payout/generation business rule, except the reconciliation in D6.

---

## Objective

Close the gaps between "every feature has its own checks" and "the whole API is hardened as one system". The work covers: a green CI gate with a dependency audit; correct client-IP handling behind a proxy; security headers on API and web; an error surface that never leaks internals; a test-enforced inventory showing every route is authenticated and rate-limited, or is on an explicit, justified allowlist; closing login timing-based enumeration; a written OWASP Top 10 (2021) audit; a query-driven DB index review; the reconciliation sweep that earlier sessions deferred; and a reproducible load-test baseline.

---

## Deliverables & Acceptance Criteria

### D0 — CI gate (verify first, extend second)

- **Precondition:** before writing any code, run `pnpm install --frozen-lockfile` from the repo root. If it fails, **stop and report**. Do not regenerate the lockfile inside this session. (The user fixes it in a separate `fix(deps)` commit before the session; this check proves that fix landed.)
- Extend `.github/workflows/ci.yml`:
  - Add a `build` job (`pnpm turbo run build`), same setup steps as the existing jobs.
  - Add an `audit` job running `pnpm audit --prod --audit-level=high`. If it reports existing high/critical advisories, fix them by upgrading in-range. If an advisory cannot be fixed in-range without a major bump, list it in `docs/security/owasp-audit.md` (D5) with the reason, and scope an `auditConfig.ignoreCves` entry to that CVE ID only. Never use a blanket ignore.
- **Acceptance:** all five CI jobs (lint, typecheck, test, build, audit) are defined, and each passes locally with the same command CI runs.

### D1 — Client IP behind a proxy + request-size limits

- Add `TRUST_PROXY` to `src/lib/env.ts`, parsed to what Fastify's `trustProxy` option accepts: `false` (default), a hop count (integer), or a comma-separated list of IPs/CIDRs. Pass it to `Fastify({ trustProxy })`. Never default to `true`: with `true`, any client can spoof `X-Forwarded-For` and get a fresh IP-scoped budget on register/login.
- Set an explicit global `bodyLimit` of 1 MB for JSON. Multipart routes keep their existing per-route `fileSize` limits. Webhook routes must still accept provider payloads (they are small, so confirm the existing tests pass).
- **Acceptance:**
  - With `TRUST_PROXY=1`, a request with `x-forwarded-for: 203.0.113.7` resolves `request.ip` to `203.0.113.7`, and the login IP limit counts against that address.
  - With `TRUST_PROXY` unset, the same header is ignored and `request.ip` is the socket address, so a spoofed header cannot reset the login budget. Test both.
  - A JSON body over 1 MB returns 413 on a representative JSON endpoint.
  - `TRUST_PROXY` is documented in `apps/api/.env.example` and the CLAUDE.md env table.

### D2 — API security headers + error surface

- Register `@fastify/helmet` (justify it briefly against hand-set headers). The API serves JSON and one WebSocket upgrade path, so use a restrictive policy: `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`, and HSTS (`max-age=31536000; includeSubDomains`) **only when `env.isProduction`**. The watermarked image streams (`/api/content/:id/serve`, `/api/generations/:id/image`) must keep `Cache-Control: no-store` and still render when the web origin requests them. Adjust CORP for those two routes only if a test shows it is needed.
- Add `app.setErrorHandler` and `app.setNotFoundHandler`:
  - Any error with `statusCode >= 500`, or without a status, answers `{ error: 'internal_error' }` with status 500. No message, no stack, no Prisma/provider text. The full error is logged server-side via `request.log.error`.
  - 4xx errors keep their current `{ error: string }` bodies. Existing route-level `{ error: err.message }` replies for typed domain errors (`AuthError`, etc.) are unchanged.
  - Fastify validation/parse errors (malformed JSON, oversize body) return `{ error: 'bad_request' }` / `{ error: 'payload_too_large' }` without echoing input.
  - Unknown routes return 404 `{ error: 'not_found' }`.
- **Acceptance:**
  - Tests assert the header set on `/health` and on one authenticated route, and that HSTS is absent outside production and present in it.
  - A test route (registered only in the test) that throws `new Error('SELECT * FROM "User" … secret')` answers exactly `{ error: 'internal_error' }` with status 500, and the body contains neither the message nor `stack`.
  - Malformed JSON returns 400 `{ error: 'bad_request' }`.
  - All existing tests still pass unmodified, except for header assertions that are strictly additive.

### D3 — Route security inventory (test-enforced)

- Add an `onRoute` hook (or an equivalent collector installed in `buildServer`) that records every registered route with: method, URL, whether its `preHandler` chain includes `authenticate`, and whether it has a rate limit (route-level `app.rateLimit()` preHandler or `config.rateLimit`).
- Add `src/security/route-policy.ts` containing two explicit, commented allowlists:
  - `PUBLIC_ROUTES`: routes intentionally without `authenticate` (e.g. `/health`, register, login, refresh, verify-email, provider webhooks, cron-secret runs, the WS upgrade if its auth works differently). Each entry carries a one-line reason, e.g. "webhook — authenticated by HMAC signature".
  - `UNLIMITED_ROUTES`: routes intentionally without a rate limit, each with a reason.
- **Acceptance:**
  - `route-inventory.test.ts` builds the real server (with test fakes) and fails, naming the offending method + URL, if any route is neither authenticated nor in `PUBLIC_ROUTES`, or neither rate-limited nor in `UNLIMITED_ROUTES`.
  - It also fails if an allowlist entry no longer matches a real route, so stale entries cannot pile up.
  - Mutation check (report it in the summary): temporarily removing `authenticate` from one route makes the test fail.
  - Any real gap the inventory finds is fixed **by adding a limit/auth with the existing patterns**, not by allowlisting it, unless public/unlimited is clearly correct. List every such fix in the summary.

### D4 — Auth hardening (small, targeted)

- **Login timing-based enumeration:** `validateCredentials` returns 401 without running bcrypt when the email is unknown, so the response is measurably faster than for a known email. Fix: on the unknown-email path, run `bcrypt.compare` against a fixed dummy hash of the same cost (12), computed once at module load, then return the same 401. Order of checks and response bodies are otherwise unchanged.
- **Pin the JWT algorithm:** configure both `@fastify/jwt` namespaces with `verify: { algorithms: ['HS256'] }` (and `sign: { algorithm: 'HS256' }` if not already the default).
- **Acceptance:**
  - A unit test with a spied `bcrypt.compare` asserts it is called exactly once on the unknown-email path and once on the wrong-password path.
  - A test shows a token signed with a different algorithm (e.g. HS512 with the same secret) is rejected with 401 on `GET /api/auth/me`.
  - Register's 409 "Email already registered" is **not** changed in this session. Record it in D5 as an accepted risk (mitigated by the 5/IP/hour limit) with a note on the future fix (uniform response + "account exists" email).

### D5 — Web security headers + written OWASP audit

- `apps/web`: add security headers for all routes: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `X-Frame-Options: DENY`, HSTS in production only, and a Content-Security-Policy.
  - The CSP uses a **per-request nonce** set in `middleware.ts` (Next 14 App Router pattern) with `script-src 'self' 'nonce-…' 'strict-dynamic'`. `'unsafe-eval'` is allowed in development only.
  - `connect-src` is `'self'` plus the origin of `NEXT_PUBLIC_API_URL` and its `ws:`/`wss:` equivalent. `img-src`/`media-src` are `'self' data: blob:` plus the API origin and the storage origin that signed URLs point at (new `NEXT_PUBLIC_MEDIA_ORIGIN`, documented in `apps/web/.env.example`). `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.
  - The middleware must not change locale resolution (cookie → `Accept-Language` → default).
- **Acceptance:**
  - The existing real-server SSR test is extended: a production `next start` response carries the CSP header with a nonce, and every inline `<script>` in the HTML carries that same nonce attribute.
  - All 39 existing web tests still pass, including the locale SSR tests.
- Write `docs/security/owasp-audit.md`: one section per OWASP Top 10 (2021) category (A01–A10). For each, list the controls in place with file references, the findings from this session and what was done about them, and the residual risks (link the relevant CLAUDE.md Open Items instead of restating them). It must at least cover: the register 409 (D4), video raw-URL residual risk (Session 09), provider wire shapes pending live verification, the in-memory rate-limit store (single instance only → Session 13), and any `pnpm audit` exceptions (D0).
- **Acceptance:** the document exists and covers all ten categories. Every "control in place" claim names a file, and no claim describes behavior the code does not have.

### D6 — Reconciliation sweep (the deferred Open Items)

- New cron route `POST /api/admin/reconciliation/run` in a new module `modules/reconciliation/`. It uses the same guard as the other cron runs: a local `secretMatches` (`crypto.timingSafeEqual`, length-checked) comparing `X-Reconciliation-Cron-Secret` with `RECONCILIATION_CRON_SECRET` (`requiredInProduction`), returning 401 before any DB access, rate-limited to 4/hour. It gets a new workflow `.github/workflows/reconciliation.yml`: daily 07:30 UTC (after the storage cleanup at 07:00), `workflow_dispatch`, a `concurrency` guard, and the secret read from the environment.
- **Pass 1 — stale generations.** A `GenerationJob` with `status = PENDING` and `createdAt` older than `GENERATION_STALE_AFTER_MS` (default: `2 × GENERATION_TIMEOUT_MS`) → in **one `$transaction`**:
  - A compare-and-set `updateMany({ where: { id, status: 'PENDING' } }, data: { status: 'FAILED' })`. If it matches zero rows, skip (another run or the live request won).
  - `walletService.addCredits` refunding exactly `GenerationJob.creditsCost` (the stored value, never recomputed from the current catalog, whose price may have changed since).
  - An `AuditLog` row `generation.reconciled_stale` with jobId and credits refunded, and **no prompt text**.
  - This must free the subscriber's one-in-flight slot.
- **Pass 2 — stale payouts (flag only).** A `Payout` in `PROCESSING` (or `PENDING`) older than `PAYOUT_STALE_AFTER_HOURS` (default 72) gets **no status change** (Paxum's status-query API is unverified, so guessing an outcome is not allowed). Write one `payout.stale_detected` audit row per payout per day (idempotent: skip if one already exists for that payout since UTC midnight). Include the count in the run summary and in the admin metrics overview as `stalePayouts` (additive field; the query-count test is updated by exactly the added query).
- Processing is keyset-paged in batches of 100, as in Session 09's cleanup. The response and summary audit row (`reconciliation.run_completed`) carry **counts only**: `{ generationsReconciled, generationsSkipped, stalePayoutsFlagged }`.
- **Acceptance:**
  - Tests cover: a stale job gets refunded + FAILED + slot freed (a new `POST /api/generations` succeeds afterwards); a fresh `PENDING` job is untouched; a replay refunds nothing a second time; two concurrent runs refund once; a stale payout gets exactly one flag per day and its status is unchanged; wrong/missing secret returns 401 with zero DB calls.
  - The Session 08 anchor non-leakage test still passes.

### D7 — DB index review (query-driven)

- Write `docs/performance/index-review.md`. List every hot query path (checkout, webhook confirmation, the renewal sweep's "existing PENDING SUBSCRIPTION for pair" check, payout balance and run `groupBy`, content list/serve access check, conversation list, generation list, both cleanup/reconciliation sweeps, admin listings, and the forensic trace lookup), each with its `where`/`orderBy` shape and the index that serves it, or "none".
- Add **only** indexes backed by a named row in that table. Required: an expression index `AuditLog_traceCode_idx` on `((metadata->>'traceCode'))`, partial `WHERE action IN ('content.served', 'generation.image_served')` (closes the Session 09 Open Item). Others are at your discretion, one justification line each. Candidates to evaluate: `PaymentTransaction (userId, modelId, type, status)` for the renewal check; `GenerationJob (status, createdAt)` for D6; `GenerationJob (status, expiresAt)` for cleanup; `Content (deletedAt)` partial for cleanup. Also remove indexes that are pure duplicates of a unique constraint's leading column, only if you can show the duplication.
- A single migration `…_security_index_review`, hand-written/`prisma migrate diff` (same offline method as Session 11). Expression/partial indexes are raw SQL in the migration, with a matching comment in `schema.prisma`. Apply it with `pnpm --filter @creator-platform/api exec prisma migrate deploy` (Supabase may need 30–60 s to wake after a pause). If the DB is unreachable, leave it **generated, not applied**, and say so. Never claim it was applied without `prisma migrate status` output.
- **Acceptance:** the doc exists with every listed path covered; the migration only contains indexes the doc justifies; `prisma migrate status` output is included in the summary.

### D8 — Load-test baseline (reproducible, not in CI)

- `apps/api/scripts/load/` holds an `autocannon` script (devDependency; justify it against k6, e.g. no external binary and same TS toolchain) that boots `buildServer` with `AI_PROVIDER=mock`, `PAYMENT_PROVIDER_*=mock`, `PAYOUT_PROVIDER=mock`, pointed at whatever `DATABASE_URL` the operator supplies. It **refuses to run** if `NODE_ENV=production` or the URL host matches a denylist env (`LOAD_TEST_FORBIDDEN_HOSTS`). Run with `pnpm --filter @creator-platform/api load`.
- Scenarios: `GET /health`, `POST /api/auth/login` (reported separately as the bcrypt-bound worst case), `GET /api/content/model/:id` (anonymous), `GET /api/wallet/balance` (authenticated), `GET /api/messages/conversations` (authenticated). The report gives p50/p95/p99 latency, req/s, and non-2xx counts per scenario, printed as a table and written to `docs/performance/load-baseline.md`, recording the environment it ran in.
- Rate limits will trip during the run. The script counts 429s separately and does **not** disable limits. Run each scenario within its own budget or across several seeded users.
- **Acceptance:** the script runs end-to-end against a local/dev DB and produces the baseline file. If no non-production DB is available, the script and a dry-run mode against `/health` alone are delivered, and the baseline file says so honestly.

---

## Security Requirements

- No secret, token, prompt, anchor text, storage key, email address, or provider response body in any new response, log line above debug, or audit row.
- No existing rate-limit value changes. New per-user limits use only the Session 11.5 `preHandler` form.
- `trustProxy` is never `true`. Every new cron secret uses `crypto.timingSafeEqual` with a length check and rejects before any DB access.
- The error handler must be tested so it cannot leak a 5xx message, including errors thrown from a route's preHandler.
- CSP must not use `'unsafe-inline'` for scripts in production.
- All new env vars go into `env.ts` validation, `vitest.setup.ts`, both `.env.example` files, and the CLAUDE.md env table.

## Performance Requirements

- Helmet, the error handler, and the route inventory add no per-request DB or network call. The inventory runs at registration time only.
- The reconciliation sweep is keyset-paged (100/page) and never loads a table into memory.
- New indexes must not be added to write-hot tables without a named read path that justifies the write cost (`AuditLog` gets one partial index only).

## Tech Choices Guidance

- `@fastify/helmet` for API headers, justified in one line. Web headers go through `next.config.mjs` `headers()` for static ones and `middleware.ts` for the nonce CSP.
- `autocannon` for load tests. No hosted load-testing service, no new account.
- Reuse existing seams: `walletService.addCredits` for refunds, the local `secretMatches` pattern per cron route (same as Sessions 06/06.5/09, no shared extraction), and `test/fake-prisma.ts` extended only as needed.
- Briefly justify every new dependency in the session summary.

---

## Definition of Done

- [ ] D0: `pnpm install --frozen-lockfile` verified clean at start; CI has lint/typecheck/test/build/audit jobs, all green locally
- [ ] D1–D8 implemented as specified; anything deliberately not done is listed with the reason
- [ ] New tests for every acceptance bullet; mutation check reported for D3; full suite green with zero regressions (report new API/web/shared totals)
- [ ] `pnpm turbo run typecheck lint test build` and root `pnpm lint` (incl. jsx-a11y) green
- [ ] No hardcoded secrets; all new env vars wired in `env.ts`, `vitest.setup.ts`, `.env.example` files
- [ ] Migration generated; applied status proven with `prisma migrate status` output (or explicitly "generated, not applied")
- [ ] `docs/security/owasp-audit.md`, `docs/performance/index-review.md`, `docs/performance/load-baseline.md` present
- [ ] CLAUDE.md updated: Session 12 entry (Summary / Notes & deviations / External Prerequisites), Architecture Decisions for Session 12, env table, Repository Structure, Open Items (close stale-generation, trace-index; update payout-reconciliation to "flagged, not auto-resolved"; add Session 12.5 for FX + credit-spend sharing; move Redis rate-limit store + messaging pub/sub to Session 13)
- [ ] ARIA validation passed
