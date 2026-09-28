# OWASP Top 10 (2021) audit — Session 12

Scope: `apps/api` (Fastify), `apps/web` (Next.js 14), CI and cron workflows.
Paths are relative to the repo root; `api/` means `apps/api/src/`. Residual
risks that CLAUDE.md already tracks are linked to its **Open Items** section
rather than restated.

Every "control in place" below names the file that implements it. Session 12
findings are marked **[S12]** with what was done about them.

---

## A01 — Broken Access Control

**Controls in place**

- `authenticate` (access-token cookie → `request.user`) and `authorize(...roles)`
  RBAC hooks — `api/middleware/auth.ts`.
- Identity always comes from the verified JWT, never a body/query field (e.g.
  `api/modules/wallet/wallet.routes.ts`, `api/modules/payouts/payouts.routes.ts`
  `PUT /payout-email`).
- Admin plugin applies `authenticate` + `authorize('admin')` at plugin scope, so
  no admin route can be added without them — `api/modules/admin/admin.routes.ts`.
- Tier/ownership access check on every serve and list — `resolveAccess` in
  `api/modules/content/content.service.ts`.
- 404-not-403 for another user's resources so ids are not enumerable —
  `api/modules/payouts/payouts.service.ts` (`getPayoutDetail`),
  `api/modules/messaging/messaging.service.ts`,
  `api/modules/generation/generation.service.ts`.
- CORS limited to the single `APP_URL` origin with credentials — `api/index.ts`.
- Cron endpoints authenticated by per-route shared secrets compared with
  `crypto.timingSafeEqual` before any DB access — `api/modules/payouts/payouts.routes.ts`,
  `api/modules/subscriptions/subscriptions.routes.ts`,
  `api/modules/storage-cleanup/storage-cleanup.routes.ts`,
  `api/modules/reconciliation/reconciliation.routes.ts`.
- **[S12]** Test-enforced route inventory: every route must be authenticated
  or listed in `PUBLIC_ROUTES` with a reason, and rate-limited or listed in
  `UNLIMITED_ROUTES` — `api/security/route-inventory.ts`,
  `api/security/route-policy.ts`, `api/security/route-inventory.test.ts`.

**Findings [S12]**

- The inventory found **no unauthenticated route that should have been
  authenticated** — every open route is a webhook (HMAC), a cron run (shared
  secret), a pre-session auth route, `/health`, or the public catalogue.
- It found **15 routes with no rate limit**, now fixed with the existing
  patterns (see A04/A07 for the values and `api/security/route-policy.ts`).

**Residual risks**

- `AdminGate` in the web app is a convenience redirect only; the server-side
  `authorize('admin')` is the boundary (by design, Session 11).
- Video serving returns a 60 s signed URL to the **unwatermarked original**
  (Session 09 Option B) — see Open Items → "Video watermarking" and
  "`ProtectedMedia` is not wired into a real viewer yet".
- Content published after a subscription starts is not auto-granted — Open
  Items.

## A02 — Cryptographic Failures

**Controls in place**

- Passwords: bcrypt cost 12; refresh tokens SHA-256 pre-digested then bcrypt
  cost 10 (defeats bcrypt's 72-byte truncation) — `api/modules/auth/auth.service.ts`.
- Tokens only in `httpOnly`, `SameSite=Strict` cookies, `Secure` in production —
  `api/modules/auth/auth.routes.ts` (`cookieBase`).
- **[S12]** JWT algorithm pinned to HS256 for signing **and** verification on
  both namespaces — `api/index.ts`; test: `api/security/security.test.ts`
  ("JWT algorithm is pinned").
- Webhook signatures: HMAC over the raw body, constant-time compare —
  `api/modules/payments/adapters/signature.ts`, used by the Woovi, NOWPayments
  and Paxum adapters.
- Forensic trace code: HMAC-SHA256 under a ≥32-char secret enforced at boot —
  `api/modules/protection/trace.ts`, `api/lib/env.ts` (`requiredMinLength`).
- **[S12]** HSTS (`max-age=31536000; includeSubDomains`) in production on the
  API (`api/index.ts`, helmet) and the web app (`apps/web/next.config.mjs`).
- Signed URLs for all media (≤300 s) — `api/lib/storage.ts`; storage keys never
  serialized.

**Residual risks**

- `JWT_SECRET` / `JWT_REFRESH_SECRET` are required at boot but **no minimum
  length is enforced** (`api/lib/env.ts` uses `required`, not
  `requiredMinLength`); `.env.example` asks for ≥32 chars. Not changed in this
  session (out of scope) — tracked in CLAUDE.md Open Items.

## A03 — Injection

**Controls in place**

- All DB access through Prisma's parameterized client; the application code
  contains no `$queryRaw`/`$executeRaw` (the only raw SQL is in migrations).
- Input validated with Zod `safeParse` at each route — `api/modules/*/**.schema.ts`.
- HTML email: every interpolated value passes `escapeHtml` — `api/lib/email.ts`.
- React escapes all rendered text; admin free text is never
  `dangerouslySetInnerHTML` — `apps/web/src/app/admin/models/page.tsx`,
  `apps/web/src/app/admin/reports/page.tsx`.
- Prompt injection into the likeness anchor: model display name has newlines
  stripped, and the anchor never leaves the service — `api/modules/generation/anchor.ts`;
  content-safety gate with no bypass — `api/modules/generation/safety.ts`.
- **[S12]** Browser-side defence in depth: a per-request nonce CSP with
  `'strict-dynamic'`, no `'unsafe-inline'` for scripts —
  `apps/web/src/proxy.ts` (`middleware.ts` until it was renamed to proxy in
  Session 12.6), `apps/web/src/security/csp.ts`; the API sends
  `default-src 'none'` — `api/index.ts`.

**Residual risks**

- `style-src` allows `'unsafe-inline'` because pages use React `style={…}`
  attributes; styles cannot execute script, but CSS-based exfiltration is not
  blocked. Moving to class-based styles would allow removing it.

## A04 — Insecure Design

**Controls in place**

- Prices only from the server-side catalog — `packages/shared/src/index.ts`
  (`SUBSCRIPTION_PLANS`, `CREDIT_PACKS`, `GENERATION_PRESETS`); checkout schemas
  have no amount field — `api/modules/payments/payments.schema.ts`.
- Idempotency and claims decided by the database: unique `idempotencyKey`,
  compare-and-set confirmations and payout claims, partial unique
  "one PENDING generation per subscriber" — `api/modules/payments/payments.service.ts`,
  `api/modules/payouts/payouts.service.ts`, migration
  `20260911120000_add_generation_jobs`.
- Wallet can never go negative (conditional debit + CHECK) —
  `api/modules/wallet/wallet.service.ts`.
- Ledger-derived model balance, remainder-to-platform split —
  `api/modules/payouts/revenue.ts`, `payouts.service.ts`.
- **[S12]** Reconciliation sweep — `api/modules/reconciliation/`:
  a stale PENDING generation (crash between debit and provider answer) is now
  FAILED and refunded its stored `creditsCost` in one transaction behind a CAS,
  freeing the subscriber's slot; stale PENDING/PROCESSING payouts are flagged
  once per UTC day (`payout.stale_detected`), never auto-resolved.
- **[S12]** Rate limits added to the 15 routes the inventory found unlimited:
  per user after auth (`app.rateLimit()` in `preHandler`, the Session 11.5
  form) — `GET /api/auth/me` 120/min, `POST /api/auth/logout` 20/h,
  `GET /api/onboarding/profile` 60/min, `DELETE /api/onboarding/reference-images/:imageId`
  20/h, `PATCH /api/content/:id/publish` and `DELETE /api/content/:id` 60/min,
  `GET /api/content/:id/serve` 120/min, the four generation reads 120/min,
  `GET /ws/messages` upgrades 30/min; per IP where no user exists yet
  (`config.rateLimit`) — `GET /api/auth/verify-email` 30/h,
  `POST /api/auth/refresh` 60/15 min, `GET /api/content/model/:modelId` 120/min.
  No existing limit value was changed.

**Residual risks**

- The generation success path completes the job with an unconditional
  `update`; the sweep is safe only because `GENERATION_STALE_AFTER_MS` must
  exceed `GENERATION_TIMEOUT_MS` (enforced at boot, `api/lib/env.ts`).
- Stale payouts are flagged, not resolved — Open Items → "No `Payout`
  reconciliation job" (now: flagged, not auto-resolved).
- FX-aware payouts and credit-spend revenue sharing — Open Items (Session 12.5).

## A05 — Security Misconfiguration

**Controls in place**

- Boot-time env validation; unknown provider names crash at boot —
  `api/lib/env.ts`, `api/modules/*/provider.factory.ts`.
- **[S12]** `TRUST_PROXY` → Fastify `trustProxy`: default `false`, hop count or
  CIDR list, `true` **rejected at boot** so `X-Forwarded-For` cannot be spoofed
  to reset IP-scoped budgets — `api/lib/env.ts` (`parseTrustProxy`), `api/index.ts`.
- **[S12]** 1 MB global JSON `bodyLimit` (multipart keeps its per-route
  `fileSize` limits) — `api/index.ts`.
- **[S12]** API security headers via `@fastify/helmet` (CSP
  `default-src 'none'; frame-ancestors 'none'`, `nosniff`, `no-referrer`,
  CORP `same-site`, `X-Frame-Options: DENY`, HSTS in production) — `api/index.ts`.
- **[S12]** Error surface: 5xx → `{ error: 'internal_error' }` with the full
  error logged server-side only; parse errors → `bad_request`; oversize →
  `payload_too_large`; unknown route → `not_found` —
  `api/security/error-handler.ts`. The two raw-body webhook parsers now raise
  Fastify's invalid-JSON error instead of a `SyntaxError` that quoted the body —
  `api/modules/payments/payments.routes.ts`, `api/modules/payouts/payouts.routes.ts`.
- **[S12]** Web static headers (`nosniff`, `strict-origin-when-cross-origin`,
  `Permissions-Policy`, `X-Frame-Options: DENY`, HSTS in production) —
  `apps/web/next.config.mjs`.

**Findings [S12] outside D0–D8 — resolved in the Session 12 addendum**

- `.github/workflows/storage-cleanup.yml` and
  `.github/workflows/subscription-renewals.yml` send
  `Content-Type: application/json` with an **empty body**. Fastify parses a
  declared JSON body before the route runs, so both runs are answered
  `400 bad_request` and never reach their route (this was already true before
  Session 12 — `FST_ERR_CTP_EMPTY_JSON_BODY`). `weekly-payout.yml` is
  unaffected (the payouts plugin's own parser accepts an empty body). The new
  `reconciliation.yml` sends no Content-Type. Fix: drop the header from the two
  workflows. Added to CLAUDE.md Open Items — fixed in the Session 12 addendum
  (header removed from both workflows).

## A06 — Vulnerable and Outdated Components

**Controls in place**

- **[S12]** CI `audit` job: `pnpm audit --prod --audit-level=high` —
  `.github/workflows/ci.yml`. CI installs with `--frozen-lockfile`.
- **[S12]** Fixed by in-range upgrades: `sharp` → 0.35.5 (libheif advisory
  GHSA-rgj7-g3m4-5g8c), `fast-uri` → 3.1.8 (7 advisories, via
  `@fastify/ajv-compiler`), `find-my-way` → 9.9.0 (CVE-2026-47219),
  `nanoid` → 3.3.19 (CVE-2026-67213, CVE-2026-67214, via `postcss`).
- **[S12.6]** `next` 14.2.35 → **16.3.6** (with React 19.3): every Next 14 /
  `postcss@8.4.31` exception below is resolved by the upgrade, and the
  `pnpm.auditConfig` block has been **removed** from root `package.json` — zero
  exceptions remain. Next 16.3.6 pins `postcss@8.5.23`, which has no advisory,
  so no `pnpm.overrides` entry was needed.
- **[S12.6]** Defence in depth for the Image Optimization API:
  `images: { unoptimized: true }` in `apps/web/next.config.mjs` makes `next start` answer
  `/_next/image` with a 404 (verified empirically — it served `200 image/png`
  on 16.3.6 without it); pinned by `apps/web/src/i18n/ssr.test.ts`.

**Exceptions** — none. The Session 12 exceptions, kept here for the record, all
**resolved by Session 12.6**:

| Id                                   | Package            | Severity     | Summary                                               | Exposure here                                                                                                     | Status           |
| ------------------------------------ | ------------------ | ------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| GHSA-2xp9-vwfh-vxw4                  | next               | **critical** | Unauthenticated RCE in the Image Optimization API     | The app renders no `next/image`, but `next start` still serves `/_next/image`. Endpoint now closed (404) as well. | Resolved (S12.6) |
| CVE-2026-75604 (GHSA-p293-qw3h-jr36) | next               | critical     | Unauthenticated RCE on **Windows-hosted** servers     | Not applicable to a Linux host.                                                                                   | Resolved (S12.6) |
| CVE-2026-44573 (GHSA-36qx-fr4f-26g5) | next               | high         | Middleware/proxy bypass in **Pages Router** apps      | App Router only; the proxy sets headers, it is not an auth gate.                                                  | Resolved (S12.6) |
| CVE-2026-44578 (GHSA-c4j6-fc7j-m34r) | next               | high         | SSRF in applications using WebSocket upgrades         | The Next app handles no WebSocket upgrades (the socket is on the API); low.                                       | Resolved (S12.6) |
| CVE-2026-64645 (GHSA-p9j2-gv94-2wf4) | next               | high         | SSRF in rewrites via attacker-controlled input        | No `rewrites` configured.                                                                                         | Resolved (S12.6) |
| CVE-2026-64649 (GHSA-89xv-2m56-2m9x) | next               | high         | SSRF in Server Actions on custom servers              | No Server Actions; no custom server.                                                                              | Resolved (S12.6) |
| CVE-2026-64641 (GHSA-m99w-x7hq-7vfj) | next               | high         | DoS in App Router using Server Actions                | No Server Actions.                                                                                                | Resolved (S12.6) |
| GHSA-q4gf-8mx6-v5v3                  | next               | high         | DoS with Server Components                            | Applies (App Router).                                                                                             | Resolved (S12.6) |
| GHSA-8h8q-6873-q5fj                  | next               | high         | DoS with Server Components                            | Applies (App Router).                                                                                             | Resolved (S12.6) |
| GHSA-h25m-26qc-wcjf                  | next               | high         | HTTP request deserialization DoS (insecure RSC usage) | Applies (App Router).                                                                                             | Resolved (S12.6) |
| CVE-2026-45623 (GHSA-6g55-p6wh-862q) | postcss (via next) | high         | File read via attacker-controlled CSS/source maps     | Build-time only; the app processes no untrusted CSS.                                                              | Resolved (S12.6) |
| CVE-2026-73646 (GHSA-r28c-9q8g-f849) | postcss (via next) | high         | Path traversal in previous source-map auto-loading    | Build-time only.                                                                                                  | Resolved (S12.6) |

**Residual risk:** none gated. Moderate/low advisories are not gated; at the
time of Session 12.6 two moderate `fastify` advisories are open in `apps/api`
(GHSA-w2qp-rph6-63g4, GHSA-3m5p-2c4r-xxw2 — both patched in `fastify` 5.12.1),
left for a session that may change the API (see CLAUDE.md Open Items).

## A07 — Identification and Authentication Failures

**Controls in place**

- Register 5/IP/hour, login 10/IP/15 min (`config.rateLimit`), refresh and
  verify-email now IP-limited **[S12]** — `api/modules/auth/auth.routes.ts`.
- Refresh-token rotation; stored hash invalidated on logout; suspension honoured
  at login and refresh — `api/modules/auth/auth.service.ts`.
- Email verification before login; password checked before revealing
  "unverified"/"suspended" — `auth.service.ts` (`validateCredentials`).
- **[S12]** Login timing equalised: an unknown email now runs one cost-12
  `bcrypt.compare` against a dummy hash computed at module load, like a wrong
  password on a real account — `auth.service.ts` (`DUMMY_PASSWORD_HASH`); test:
  `api/security/security.test.ts`.
- **[S12]** Client IP resolution cannot be spoofed by default (A05), so the IP
  budgets above hold.

**Accepted risk [S12]**

- `POST /api/auth/register` still answers **409 "Email already registered"**,
  which tells a caller an address has an account. Mitigated by the 5/IP/hour
  limit (and, with `TRUST_PROXY` set correctly, that limit is per real client).
  Future fix: answer registration uniformly (same 201 body either way) and send
  the existing owner an "account already exists" email instead of creating
  anything. Left unchanged per the Session 12 spec.

**Residual risks**

- Rate-limit counters live in the **in-memory** store: correct for one API
  instance only; with several instances each has its own budget. Redis-backed
  store is scheduled for Session 13 — Open Items.
- No per-account lockout (limits are per IP) and no MFA.
- JWT secret length not enforced (A02).

## A08 — Software and Data Integrity Failures

**Controls in place**

- Webhooks accepted only with a valid signature over the raw bytes, verified
  before any DB access — `api/modules/payments/payments.routes.ts`,
  `api/modules/payouts/payouts.routes.ts`, `api/modules/payments/adapters/signature.ts`.
- Lockfile enforced in CI (`pnpm install --frozen-lockfile`) —
  `.github/workflows/ci.yml`; install scripts allowlisted
  (`pnpm.onlyBuiltDependencies`) — root `package.json`.
- Every money movement and admin action is audit-logged in the same
  transaction as the change — e.g. `api/modules/wallet/wallet.service.ts`,
  `api/modules/admin/admin.service.ts`.

**Residual risks**

- Provider wire formats (Woovi, NOWPayments, Paxum, Replicate) are written from
  public docs and tested only against mocked HTTP — Open Items → "Provider
  request/response shapes need live verification", "Paxum request/response
  shapes…", "`ReplicateAdapter` wire shapes…".

## A09 — Security Logging and Monitoring Failures

**Controls in place**

- `AuditLog` rows for payments, payouts, wallet moves, admin decisions, and
  every image/video serve (trace code) — `api/modules/protection/trace.ts` and
  the services above.
- Logger redaction of message bodies — `api/index.ts` (`redact`).
- **[S12]** Unhandled errors logged in full server-side, never returned —
  `api/security/error-handler.ts`.
- **[S12]** Forensic trace lookup indexed (`AuditLog_traceCode_idx`) —
  migration `20260927120000_security_index_review`, see
  `docs/performance/index-review.md`.
- **[S12]** Stale payouts surface as `payout.stale_detected` audit rows and as
  `stalePayouts` on `GET /api/admin/metrics/overview` —
  `api/modules/reconciliation/reconciliation.service.ts`,
  `api/modules/admin/admin.service.ts`.

**Residual risks**

- No error monitoring or alerting yet (Sentry/uptime are Session 13
  prerequisites); a stale-payout flag waits until an admin looks.
- Serve-trace rows grow with views — Open Items → "One `AuditLog` row per
  image/video serve".

## A10 — Server-Side Request Forgery

**Controls in place**

- No endpoint fetches a user-supplied URL. Outbound calls go to base URLs fixed
  by env/config — Woovi, NOWPayments, Paxum (`api/modules/payments/adapters/*`,
  `api/modules/payouts/adapters/paxum.adapter.ts`) and Replicate
  (`api/modules/generation/adapters/replicate.adapter.ts`, `REPLICATE_API_URL`).
- Reference-image URLs sent to Replicate are our own short-TTL signed URLs —
  `api/modules/generation/generation.service.ts`.
- **[S12]** `fast-uri` SSRF/host-confusion advisories fixed (A06).

**Residual risks**

- The Replicate adapter downloads the output image from whatever URL the
  prediction response names (`download()` in `replicate.adapter.ts`), without a
  host allowlist. It sends no credentials on that request, and the URL comes
  from Replicate over TLS, not from a user — but pinning it to Replicate's
  delivery host would close the gap. Tracked in CLAUDE.md Open Items.
