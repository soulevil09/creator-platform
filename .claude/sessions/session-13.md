# Session 13 — MVP Deployment (DigitalOcean + Docker Compose + Caddy)

## Context Recap (from CLAUDE.md)
- TypeScript pnpm/Turborepo monorepo: `apps/web` (Next.js 16.3 + React 19, `proxy.ts` CSP nonce), `apps/api` (Fastify 5.12.5, Prisma + Supabase Postgres, Supabase Storage via S3 SDK), `packages/shared`. Sessions 01–12.6 complete; green = `pnpm turbo run typecheck test build` + root `pnpm lint` + `pnpm audit --prod --audit-level=high`.
- Providers sit behind env-driven, memoised factories with boot-time asserts: payments (`pix: woovi|mock`, `crypto: nowpayments|mock`, `card: mock`), payouts (`paxum|mock`), AI (`replicate|mock`). Email is hard-wired to Resend (`createResendEmailer`, `EMAIL_API_KEY` required at boot).
- Web and API must share one registrable domain (CORP `same-site` + `SameSite=Strict` cookies). `TRUST_PROXY` must be a hop count/CIDR, never `true`. Rate-limit store and messaging fan-out are in-process (single instance only).
- ADMIN users are provisioned out-of-band — there is no public path or script to create one today. There is no frontend login/register UI yet.
- Open audit items closed by this session: `JWT_SECRET`/`JWT_REFRESH_SECRET` min length not enforced at boot.

## External state (already done by the owner — do not redo, reference only)
- Domain `visorfans.com` on Cloudflare (Registrar + DNS). Apex points to a Vercel "coming soon" landing (A `76.76.21.21`, DNS only) — **must not be touched**.
- Hosting: DigitalOcean droplet `visorfans-prod`, NYC1, Ubuntu 24.04, 1 GB RAM (upgrade to 2 GB at launch), cloud firewall 22/80/443, SSH by key.
- Supabase project in `us-east-2` (kept).
- NOWPayments: account (Adult Platforms), USDT TRC-20 wallet whitelisted, API key + IPN secret. No sandbox — validated with a small real payment after deploy.
- Sentry projects `visorfans-api` and `visorfans-web` (DSNs held by owner).
- 7 secrets in Bitwarden; 5 GitHub Actions secrets; cron workflows disabled in the GitHub UI until deploy.
- Replicate account exists, but **AI ships `disabled`** on the first deploy.
- Pending (not blockers): transactional email (Resend rejected — AUP bars adult; Mailgun ticket open; Amazon SES as plan B; will send from `mail.visorfans.com`), Woovi credentials + 18+ acceptance, Paxum Business account, legal pages on the landing.

## Objective
Put the platform on the internet at `app.visorfans.com` (web) and `api.visorfans.com` (API) on the existing droplet, safely, with every channel whose provider account is not live switched **off** rather than mocked. The session has two parts:

- **Part A — code (Claude Code implements, CI-verifiable):** per-provider `disabled` mode, production mock ban, env hardening, Sentry with PII scrubbing, ops CLI for provisioning users, readiness probe, Dockerfiles, Compose + Caddy, image build/push + deploy workflow, smoke test, droplet bootstrap script, runbook.
- **Part B — cutover (the owner executes from the runbook; Claude Code does NOT SSH into production or touch DNS/dashboards):** DNS, droplet hardening, first deploy, admin provisioning, NOWPayments IPN + live payment, cron re-activation.

Explicitly **out of scope**: Redis rate-limit store / messaging pub/sub (single instance — stays deferred, see Open Items), any Mailgun/SES adapter (separate mini-session once an account is approved), Woovi/Paxum activation, frontend auth/subscriber UI, legal pages, AI image editing.

---

## Deliverables & Acceptance Criteria

### D1 — Provider mode `disabled` for every channel + production mock ban
Channels: `PAYMENT_PROVIDER_PIX`, `PAYMENT_PROVIDER_CRYPTO`, `PAYMENT_PROVIDER_CARD`, `PAYOUT_PROVIDER`, `AI_PROVIDER`, and a new `EMAIL_PROVIDER`.

Allowed values:

| Variable | Allowed | Production-allowed |
|---|---|---|
| `PAYMENT_PROVIDER_PIX` | `woovi` \| `mock` \| `disabled` | `woovi`, `disabled` |
| `PAYMENT_PROVIDER_CRYPTO` | `nowpayments` \| `mock` \| `disabled` | `nowpayments`, `disabled` |
| `PAYMENT_PROVIDER_CARD` | `mock` \| `disabled` | `disabled` (CCBill later) |
| `PAYOUT_PROVIDER` | `paxum` \| `mock` \| `disabled` | `paxum`, `disabled` |
| `AI_PROVIDER` | `replicate` \| `mock` \| `disabled` | `replicate`, `disabled` |
| `EMAIL_PROVIDER` | `resend` \| `mock` \| `disabled` | `disabled` only, for now |

Rules:
- **Default when unset is `disabled`** for every channel (fail closed). Unknown values still crash at boot.
- **`NODE_ENV=production` + any `mock` → boot crash** naming the offending variable. Reason: `MockPaymentProvider` verifies webhooks with a hardcoded, public secret — anyone could mint "confirmed" payments.
- **`EMAIL_PROVIDER=resend` is rejected in production** (Resend's AUP bars adult businesses). Keep the Resend adapter only for non-production until it is replaced; do not delete it in this session.
- **Credentials are required only for the active adapter.** E.g. with `PAYMENT_PROVIDER_PIX=disabled`, `OPENPIX_APP_ID`/`OPENPIX_WEBHOOK_SECRET` are not required; with `woovi` they are, and boot fails without them. Same for NOWPayments, Paxum, Replicate (`AI_PROVIDER_API_KEY`), Resend (`EMAIL_API_KEY` becomes conditional).
- Each factory exposes `isEnabled(channel)`; business code checks it — it never compares strings against env directly.

Behaviour when a channel is disabled:
- **Checkout (subscription or credit pack) on a disabled payment channel → `503 { error: 'payment_channel_unavailable' }`**, returned before any DB write. `issueSubscriptionCharge` throws a typed error mapped to this response.
- **Webhook route of a disabled payment/payout channel → `404`**, indistinguishable from an unknown route (simplest: do not register the route). The route inventory test must pass with all channels disabled *and* all enabled.
- New **`GET /api/payments/channels`** (authenticated, per-user rate-limited) returns `{ channels: ['crypto'] }` — only enabled names, never provider names or config. The `/wallet` page uses it to hide disabled methods (strings in both catalogs).
- **Payout run (`POST /api/payouts/run` and the admin run) with payouts disabled → cron secret checked first (401 still wins), then `503 { error: 'payouts_disabled' }`**, no DB writes, one aggregate audit row is optional but must carry counts only.
- **AI disabled → generation create endpoints `503 { error: 'generation_unavailable' }` before any credit debit**; read endpoints for existing jobs keep working.
- **Renewal sweep:** a subscription whose channel is disabled gets **no charge issued**; it is counted in the response as `skippedChannelDisabled`. The rest of the lifecycle (grace → expiry) is unchanged. The sweep stays idempotent.
- **Email disabled — classify every `emailer` call site** (list them in the summary):
  - Flows that *depend* on the email arriving (registration verification, resend-verification, any password-reset if present) → **fail closed: `503 { error: 'registration_unavailable' }`** (or an equivalent typed code) before creating any row.
  - Notification-only flows (renewal reminders, notices) → skip the send, log at `info` with no recipient address, count in aggregates (`remindersSkipped`).
  - A `DisabledEmailer` implementing `Emailer` throws a typed `EmailDisabledError` if ever reached, so a forgotten call site fails loudly in tests rather than silently.

Acceptance (tests, using existing fakes + `nock` with `disableNetConnect`):
- Boot matrix test: each channel × {unset, `disabled`, active-without-creds, active-with-creds, `mock` in prod, `mock` in dev, unknown} asserts boot/crash and the error message.
- Checkout 503 per disabled channel with zero DB writes (fake-prisma call count = 0 for writes).
- Webhook 404 for disabled channels; existing signature tests still pass when enabled.
- Payout run: 401 without secret, 503 with secret when disabled.
- Generation 503 with no `debitCredits` call.
- Register 503 when email disabled; no `User` row created.
- Renewal sweep counts `skippedChannelDisabled` and issues no charge; second run is a no-op.
- Card channel default is `disabled`; update the Engineering Invariant wording in your summary ("card accepts `mock` (non-prod) or `disabled` until CCBill").

### D2 — Env hardening
- `JWT_SECRET` and `JWT_REFRESH_SECRET` use `requiredMinLength(…, 32)`; boot also fails if they are equal.
- `NODE_ENV=production` additionally requires: `APP_URL` and `API_PUBLIC_URL` to be `https://` URLs on the same registrable domain (simple check: identical last two labels — note in a comment that this is not a PSL check and is enough for `visorfans.com`), `TRUST_PROXY` set to a hop count or CIDR list, `WATERMARK_TRACE_SECRET` (already), all active cron secrets.
- `.env.example` files updated: new `EMAIL_PROVIDER`, `SENTRY_*`, `disabled` documented, Resend marked non-production.
- Tests for each new boot rule.

### D3 — Sentry (API + web) with PII scrubbing
- API: `@sentry/node` with the Fastify integration. Web: `@sentry/nextjs`. Both **inert when the DSN is unset** (tests and local dev run without it).
- `sendDefaultPii: false`. A shared, unit-tested scrubber (`beforeSend` + `beforeSendTransaction` + `beforeBreadcrumb`) that:
  - drops request bodies entirely and all cookies;
  - removes headers `cookie`, `set-cookie`, `authorization`, every `x-*-signature`/`x-*-sig`, any cron-secret header, `x-forwarded-for`;
  - strips query strings from URLs (kills `X-Amz-*` signed-URL params and verification tokens);
  - removes `user.email`, `user.ip_address`; keeps only the user id;
  - redacts email-shaped strings and values of keys matching `/password|secret|token|key|prompt|payoutEmail/i` in `extra`/`contexts`.
- Capture only 5xx / unhandled errors (4xx are not reported). `tracesSampleRate` default `0` (env-overridable). `environment` and `release` (= git SHA build arg) set.
- Web: use Sentry's **tunnel route** so the CSP `connect-src` stays `'self'`-only; confirm the tunnel path passes through `proxy.ts` without breaking the nonce. Source maps: uploaded only if `SENTRY_AUTH_TOKEN` exists in CI, and **never served publicly**.
- Env: `SENTRY_DSN` (api), `NEXT_PUBLIC_SENTRY_DSN` (web, build-time), `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT_*` (CI only, optional).
- Tests: scrubber unit tests with a realistic event containing every forbidden field → none survive. CSP test still passes.

### D4 — Ops CLI: provision a verified user
Needed because ADMIN is out-of-band and registration is closed while email is disabled.
- `apps/api/scripts/ops/create-user.ts`, compiled into the API image; run as `docker compose exec api node dist/scripts/ops/create-user.js --role admin --email you@x`.
- Roles `admin | model | subscriber`. Creates a **verified** user (bcrypt cost 12, same hashing path as auth service). Model role also creates the minimal profile the domain requires, left `PENDING` approval.
- **Password read from stdin only** (hidden TTY prompt, or piped) — never from argv/env (shell history, `ps`). Enforces the auth service's password policy.
- Refuses an existing email (exit 1, no change). Writes an `AuditLog` row `user.provisioned` with role and actor `system:cli` — no password, no hash.
- Prints only the new user id. Tests cover: creates verified user, rejects duplicate, rejects weak password, password never appears in output or audit.

### D5 — Readiness probe
- Keep `GET /health` as liveness (no DB). Add `GET /health/ready`: `SELECT 1` with a 2 s timeout → `200 { status: 'ok' }` or `503 { status: 'unavailable' }`; never returns version, error text or DB host.
- Listed in `PUBLIC_ROUTES` (with reason) and IP rate-limited (or `UNLIMITED_ROUTES` with a reason if you justify it — Docker healthchecks hit it every 15 s from inside the network). Route inventory test passes.

### D6 — Container images
- `apps/api/Dockerfile` and `apps/web/Dockerfile`, multi-stage, built from repo root context, base `node:22-bookworm-slim` (glibc for `sharp` + Prisma engines) pinned by digest.
- pnpm via Corepack at the version in `package.json`; `pnpm install --frozen-lockfile`; API uses `pnpm deploy --filter @creator-platform/api --prod` (or equivalent) for a pruned runtime; Prisma client generated with the correct `binaryTargets` for the runtime image.
- Web uses `output: 'standalone'`. All `NEXT_PUBLIC_*` values (`APP_URL`, `API_URL`, `DEFAULT_LOCALE`, `MEDIA_ORIGIN`, `SENTRY_DSN`) are **build args** — document that changing them requires a rebuild.
- Runtime: non-root user, `NODE_ENV=production`, `--max-old-space-size` set (api ~256 MB, web ~256 MB — justify), `HEALTHCHECK` (api → `/health`, web → `/`), no dev deps, no `.env`, no source maps in the web image's public output.
- `.dockerignore` excludes `node_modules`, `.env*`, `.git`, `.next*`, test output.
- `prisma migrate deploy` runnable from the API image (`node … prisma migrate deploy` via the pinned CLI — never a bare root `npx prisma`).
- Report final image sizes in the summary.

### D7 — Docker Compose + Caddy
Files under `infra/`: `compose.yaml`, `Caddyfile`, `deploy.sh`, `bootstrap.sh`.
- Services: `caddy` (only service publishing 80/443), `api`, `web` on an internal network; one-off `migrate` service (profile `migrate`) using the API image.
- Images referenced by `ghcr.io/<owner>/creator-platform-{api,web}:${IMAGE_TAG}`.
- `env_file: /opt/visorfans/env/api.env` (and `web.env` if any runtime vars) — outside the repo, `chmod 600`, owned by `deploy`.
- `restart: unless-stopped`; memory limits sized for a 1 GB droplet + 2 GB swap (justify numbers; Caddy small); `logging` json-file `max-size: 10m`, `max-file: 3`; healthchecks wired to `depends_on: condition: service_healthy`.
- `Caddyfile`:
  - `api.visorfans.com` (Cloudflare **DNS only**) → automatic Let's Encrypt; `reverse_proxy api:4000`; WebSocket upgrade works; `request_body max_size` ≥ the API's largest upload limit (state both numbers); remove `Server` header; do not add security headers the app already sets (no duplicates).
  - `app.visorfans.com` (Cloudflare **proxied**) → TLS from a **Cloudflare Origin CA certificate** mounted read-only from `/opt/visorfans/certs/` (Cloudflare SSL mode *Full (strict)*); `reverse_proxy web:3000`.
  - Caddy must **not** trust client-supplied `X-Forwarded-For` (no `trusted_proxies` on the api site) so the API's `TRUST_PROXY=1` sees exactly one hop: Caddy. Document why the app site does not need real client IPs.
  - Any other Host → `abort` (no default site leaking the IP).
- `deploy.sh <sha>`: validates `<sha>` against `^[0-9a-f]{7,40}$`, pulls both images, runs `migrate` (abort the deploy on failure), `up -d`, waits for `api` and `web` healthy (timeout), and on failure **rolls back** to the previous tag stored in `/opt/visorfans/.current_tag`. Idempotent; `set -euo pipefail`; logs to `/opt/visorfans/deploy.log`.

### D8 — CI/CD: build, push, deploy
- `.github/workflows/deploy.yml`: triggers after `ci.yml` succeeds on `main` (`workflow_run`, conclusion success) plus `workflow_dispatch` with an optional `sha`.
- Builds both images with Buildx + GHA cache, pushes to GHCR tagged `<sha>` (and `latest`). `permissions: contents: read, packages: write`. All third-party actions **pinned by commit SHA**. `concurrency: deploy-production` (no cancel-in-progress). GitHub `environment: production`.
- Deploy step: plain `ssh` using secrets `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` (pinned host key — **no `StrictHostKeyChecking=no`**). The remote side is an `authorized_keys` **forced command** (`command="/opt/visorfans/bin/deploy-gate",restrict`) that reads `SSH_ORIGINAL_COMMAND`, accepts only `deploy <sha>`, and execs `deploy.sh`. The deploy key can do nothing else.
- GHCR pull on the droplet uses a read-only token stored on the droplet (`docker login` once during bootstrap) — never sent from CI.
- After deploy, run the smoke test (D9) against production; failure marks the workflow red (rollback already happened in `deploy.sh` if health failed).
- Cron workflows: `subscription-renewals.yml`, `storage-cleanup.yml`, `reconciliation.yml` unchanged in logic; verify they still send no empty-body JSON. `weekly-payout.yml` stays disabled (and would get 503 anyway). Document re-enabling in the runbook.

### D9 — Smoke test
`scripts/smoke.ts` (or `.sh`), runnable locally and from CI with `APP_URL`/`API_URL` args. Asserts:
- `GET api/health` 200; `GET api/health/ready` 200; valid TLS on both hosts; HTTP → HTTPS redirect.
- API response headers include helmet set + CORP `same-site`; no `Server`/`X-Powered-By`.
- `GET app/` 200 with a CSP header containing a nonce and no `'unsafe-inline'` in `script-src`; `/_next/image` not served.
- Disabled webhook (e.g. Woovi, Paxum) → 404; cron route without secret → 401; `POST /api/auth/register` → 503 while email is disabled.
- Unknown Host header against the droplet IP → connection aborted/no site.
- No secrets in output.

### D10 — Droplet bootstrap script + runbook
- `infra/bootstrap.sh` (run once as root by the owner, idempotent): create `deploy` user (docker group, no sudo password-less except nothing needed), install Docker Engine + Compose plugin from Docker's official apt repo, 2 GB swapfile (`vm.swappiness=10`), sshd hardening (`PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`), `unattended-upgrades` enabled for security updates with auto-reboot window, `ufw` mirroring 22/80/443, `/opt/visorfans/{env,certs,bin}` with strict perms, Docker daemon log defaults, timezone UTC. Must not lock the owner out: it checks that `/home/deploy/.ssh/authorized_keys` holds the owner's key before disabling root login.
- `docs/deployment/runbook.md`, step-by-step for the owner (English), covering at least:
  1. Cloudflare DNS: `app` A → droplet IP (**proxied**), `api` A → droplet IP (**DNS only**), apex/landing untouched; SSL mode Full (strict); create Origin CA cert for `app.visorfans.com` and place it.
  2. Supabase connection string to use from an IPv4-only droplet (Supavisor pooler) for runtime and `migrate deploy`; wake-up note for paused free projects.
  3. Filling `/opt/visorfans/env/api.env` from Bitwarden (variable list with which are required in this deploy: crypto `nowpayments`, everything else `disabled`, `TRUST_PROXY=1`, `NEXT_PUBLIC_MEDIA_ORIGIN` = Supabase storage origin).
  4. Separate deploy key generation + forced-command install; adding `DEPLOY_*` secrets in GitHub; GHCR read token on the droplet.
  5. First deploy, `create-user` for the admin, approving nothing yet.
  6. NOWPayments: IPN callback URL `https://api.visorfans.com/<actual webhook path>`; live test procedure: create a subscriber via CLI → log in with `curl` (cookie jar) → crypto credit-pack checkout → pay the smallest pack above NOWPayments' minimum for USDT TRC-20 → confirm wallet credited, `AuditLog` row, idempotency on IPN retry. Record which Open Item field names were confirmed or corrected.
  7. Re-enabling the three daily crons; keeping weekly payout off.
  8. Rollback (`deploy.sh <previous sha>`), viewing logs, resizing the droplet to 2 GB.
  9. What to watch in Sentry in the first 48 h.

---

## Security Requirements
- No secret in the repo, images, build args, workflow logs or Sentry events. `NEXT_PUBLIC_*` are public by definition — never put a secret there.
- Production refuses `mock` everywhere; disabled channels fail closed (503/404) and never fall back to mock.
- Webhook signature verification unchanged and still before the first DB statement; disabled webhooks are unreachable.
- Deploy path least-privilege: forced-command SSH key, pinned host key, SHA-pinned actions, GHCR pull token read-only and droplet-local.
- Containers non-root; only Caddy exposes ports; Postgres reached outbound only.
- `TRUST_PROXY=1` matches the real topology (client → Caddy → api); Caddy does not trust inbound XFF. Add/keep a test proving a spoofed `X-Forwarded-For` does not change the rate-limit key with `TRUST_PROXY=1` behind one proxy.
- Sentry scrubber proven by tests; anchor prompt and signed URLs never leave the process.
- `create-user` never accepts a password via argv/env and never logs it.
- All existing Engineering Invariants hold; route inventory test passes in both all-disabled and all-enabled configurations.

## Performance Requirements
- Fits a 1 GB droplet + 2 GB swap at idle and during a smoke run: report `docker stats` expectations and the chosen memory limits. No build ever runs on the droplet.
- `sharp`: cap concurrency for the small box (justify value) so watermarking cannot exhaust memory.
- Deploy downtime target: ≤ 30 s per release (sequential restart acceptable at MVP; say so).
- Image sizes reported; web image uses standalone output.
- Healthchecks cheap: liveness without DB; readiness one `SELECT 1`.

## Tech Choices Guidance
Briefly justify each choice in the summary: base image, Caddy (vs Nginx/Traefik), Origin CA vs DNS-01 for the proxied host, GHCR, forced-command SSH vs a third-party deploy action, Sentry SDKs + tunnel route, memory limits. Keep everything free-tier or already paid. Do **not** introduce Redis, Kubernetes, a PaaS, Stripe, or any Brazilian processor. Do not add a Mailgun/SES adapter in this session.

## Deliverables Summary Claude Code must return
1. File tree of new/changed files.
2. Full verbose test output (all test names) + `pnpm turbo run typecheck test build`, root `pnpm lint`, `pnpm audit --prod --audit-level=high` results.
3. Local proof: `docker compose` up on the dev machine (or CI job) with both images built, smoke test passing against it (TLS checks may be skipped locally — say which).
4. The email call-site classification list (D1).
5. Image sizes; chosen memory limits with justification.
6. `git status` before staging; `grep` proving no secrets/DSNs/tokens in tracked files.
7. Proposed CLAUDE.md deltas (env table, invariants wording, Open Items closed/opened) — ARIA writes the final CLAUDE.md.

## Definition of Done
- [ ] D1 `disabled` mode for pix/crypto/card/payout/ai/email; default `disabled`; `mock` crashes in production; creds required only when active; 503/404 behaviour tested
- [ ] D2 JWT secrets ≥ 32 chars and distinct; production URL/TRUST_PROXY rules enforced at boot
- [ ] D3 Sentry API + web, inert without DSN, scrubber unit-tested, tunnel route, CSP intact
- [ ] D4 `create-user` CLI (stdin password, audit row, tests)
- [ ] D5 `/health/ready` with inventory entry
- [ ] D6 Dockerfiles (non-root, pinned base, standalone web, migrate runnable), sizes reported
- [ ] D7 Compose + Caddyfile + `deploy.sh` with migrate-gate and rollback
- [ ] D8 Build/push/deploy workflow, SHA-pinned actions, forced-command SSH, no host-key bypass
- [ ] D9 Smoke test passing locally against compose
- [ ] D10 `bootstrap.sh` + `docs/deployment/runbook.md`
- [ ] All deliverables implemented
- [ ] Tests written and passing (full green definition)
- [ ] No hardcoded secrets
- [ ] Session security requirements met
- [ ] ARIA validation passed (Part A), then Part B cutover evidence reviewed by ARIA: both hosts on HTTPS, smoke test green in production, admin provisioned, NOWPayments live payment credited once, crons re-enabled, Sentry receiving a test event with no PII
