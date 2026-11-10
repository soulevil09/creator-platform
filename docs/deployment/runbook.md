# Production runbook — visorfans (Session 13, Part B)

Step-by-step cutover for the owner. Claude Code wrote and tested the code
(Part A); everything below touches production and is executed by you.

---

## Cutover progress log

> Keep this block updated while executing. It is the handoff between ARIA
> conversations. Remove it (or move it to CLAUDE.md) once Session 13 closes.

| §   | Step                                   | Status             | Date (BRT) |
| --- | -------------------------------------- | ------------------ | ---------- |
| 0   | Prerequisites                          | ✅ Done            | 2026-10-06 |
| 1   | Cloudflare DNS + Origin CA certificate | ✅ Done            | 2026-10-18 |
| 2   | Droplet bootstrap                      | ✅ Done            | 2026-10-20 |
| 3   | Env files + certificate on droplet     | ✅ Done            | 2026-10-25 |
| 4   | Deploy key, GitHub environment, GHCR   | ✅ Done            | 2026-10-26 |
| 5   | First deploy + admin                   | ✅ Done            | 2026-10-30 |
| 6   | NOWPayments IPN + one live payment     | ✅ Done            | 2026-11-09 |
| 7   | Re-enable crons                        | ✅ Done            | 2026-11-09 |
| 8–9 | Operations + Sentry (first 48 h)       | ✅ Done            | 2026-11-09 |

**Part B complete (2026-11-09 21:16 BRT).** Carry this log, deviations 1–30 and
the open items below into CLAUDE.md, then remove this block.

**Verified state at end of §3**

- Droplet `visorfans-prod` public IPv4 `146.190.69.232`.
- DNS: `app` → Cloudflare IPs (proxied), `api` → `146.190.69.232` (DNS only),
  apex → `76.76.21.21` (Vercel, untouched). Verified with `dig +short`.
- Cloudflare Configuration Rule `app full strict` (Hostname equals
  `app.visorfans.com` → SSL Full (strict)) is active. Zone-wide SSL mode was
  **not** changed.
- Origin CA certificate: SAN `DNS:app.visorfans.com` only, expires 2041-10-14,
  cert/key public-key hashes match. Installed at `/opt/visorfans/certs/`
  (`root:deploy`, `640`).
- Bootstrap: `deploy` user (key-only SSH, sudo with password), Docker 29.9.1,
  2 GB swap, `ufw` 22/80/443, `userland-proxy: false`, root login refused
  (`Permission denied (publickey)`). No reboot pending.
- `/opt/visorfans/env/compose.env` and `api.env` filled (`600`, `deploy`).
  `api.env`: 27 variables, none empty, no invalid lines, JWT secrets 64 chars
  and distinct, `DATABASE_URL` uses the session pooler
  `aws-1-us-east-2.pooler.supabase.com:5432` with
  `connection_limit=5&pool_timeout=20&sslmode=require`.
- GitHub Actions: CI enabled; Deploy, Reconciliation, Storage cleanup,
  Subscription renewals and Weekly payout all **disabled**.

**Verified state at end of §4**

- CI deploy key ed25519 `SHA256:m8mO2jgqda9oxMgp8+ZF1jRpUkv9uTPJYxUjRQtqX+c`,
  generated on the Mac, forced command `deploy-gate` + `restrict`; test with
  `IdentitiesOnly=yes` → `deploy-gate: refused`. `authorized_keys`: 2 lines.
  Private key only in Bitwarden Secure Note (round-trip `cmp` identical),
  deleted from the Mac.
- Host key pinned: ed25519 `SHA256:tvBk8jYk7tv/rRLz4E8LIjsxjMmng23lVFprWVAu09I`,
  matched across droplet, `ssh-keyscan` and the Mac's existing `known_hosts`.
- GitHub environment `production`: restricted to `main`. Secrets
  `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_SSH_KEY`. Variables `APP_URL`,
  `API_URL`, `NEXT_PUBLIC_MEDIA_ORIGIN` (= STORAGE_ENDPOINT host),
  `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_PROJECT_WEB`. No `SENTRY_AUTH_TOKEN`
  (no source-map upload).
- GHCR: classic PAT `read:packages` only, expires 2027-10-26 (calendar
  reminder). `docker login` as `deploy` via `read -rs` (never echoed);
  `~/.docker` 700, `config.json` 600.

**Verified state at end of §5**

- Pre-checks (2026-10-26): no reboot pending, swap 2 GB free, disk 21 % used;
  Supabase project active; `main` == `origin/main` at `471cefc`, CI green on
  that commit.
- Deploy workflow **enabled**. First run `40432351313`, sha pinned to
  `471cefcd960bd8ad84a63a5537a8ae74cde131ac`: build ✓, deploy ✓
  (pull → migrate → up → health → ready), smoke ✗ — 16/18 PASS. Both FAILs
  are smoke-test bugs (deviation 15); production verified healthy by hand.
- `.current_tag` = `471cefcd…`; api and web `healthy`; only caddy publishes
  80/443.
- Public TLS for `app` (via Cloudflare): Let's Encrypt `YE1` chain,
  `Verify return code: 0 (ok)`, Node over DNS → 200. Cloudflare adds
  `server: cloudflare` + `cf-ray`; the origin itself emits no `server`,
  `x-powered-by` or `via`.
- Real client IPs: API log `remoteAddress` is the owner's public IP, not
  `172.30.0.x`.
- Idle memory: caddy 31.8 MiB / 64 MiB (50 %), api 139.7 MiB / 448 MiB,
  web 97.9 MiB / 384 MiB.
- `vf` compose shortcut (§8) installed in `deploy`'s `~/.bashrc`.
- `/dev/protected-media` → 404 in production (`notFound()` outside dev).
- Admin `contato@visorfans.com` ("Ops") created via `create-user.js`
  (password only in Bitwarden). curl login → 200 with `access_token` +
  `refresh_token` HttpOnly, host-only on `api.visorfans.com`.
- Browser login via Safari Web Inspector on the app origin (`prompt()`
  password, never in console history) → `login 200`, `me 200 role admin`.
  Cookies flow `app` → `api` (CORS credentials, SameSite, Safari ITP OK).
- `/admin` and `/admin/users` load and stay (1 user: Ops, admin, verified,
  active; "admins cannot be suspended" guard shown); no CSP/CORS errors.
  **Nothing approved.**
- Unauthenticated `/admin` correctly redirects to `/` (`AdminGate` →
  `/api/auth/me` 401).

**Verified state at end of §6.3**

- §6.1 (2026-11-05): pre-check `.current_tag` = `471cefcd…`, api/web
  `healthy`, `/health/ready` 200. Unsigned `POST` to
  `/api/payments/nowpayments/webhook` → **400** (route exists, rejects).
  IPN callback URL saved in the NOWPayments dashboard.
- §6.1 IPN secret: container value == `api.env` value, but it did **not**
  match the dashboard (31 chars incl. 3 non-alphanumeric vs 32 alphanumeric).
  2026-11-06: IPN secret **regenerated** in the dashboard, Bitwarden updated,
  `api.env` line rewritten with `read -rs` + `awk ENVIRON` (never echoed;
  35 lines, same keys), api recreated with
  `vf up -d --no-deps --force-recreate api` → `healthy`, ready 200.
  Container sha256 prefix == dashboard sha256 prefix.
- §6.2 (2026-11-06): `NOWPAYMENTS_API_KEY` valid (min-amount call answered).
  `usdttrc20 → usdttrc20` minimum **10.780608 USDT (≈ USD 10.72)**. Only the
  `pro` pack (29.99) is above it (deviation 20).
- Dashboard fees: network fee optimisation **Do not optimize**, payment
  markup **0 %**, payment covering **0 %**, withdrawal fee paid by
  **Receiver**. Payout wallet: **USDT TRC-20**.
- §6.3 (2026-11-08): Supabase was **paused** → `create-user.js` failed with
  `PrismaClientInitializationError`; project resumed (deviation 22). Test
  subscriber `contato+buyer@visorfans.com` ("Test buyer"), user id
  `cmw8eyp5n0001f0iets65loox`, password in Bitwarden
  ("VisorFans — Test buyer", alphanumeric only). Login from `~/visorfans-test`
  (outside the repo, `umask 077`) → 200; `jar.txt` 600 with
  `access_token` + `refresh_token` HttpOnly, host-only `api.visorfans.com`;
  `login.json` deleted. Wallet balance **0**. ~20 min later the same jar →
  401 (short-lived access token, expected — deviation 24).

**Open before §6.4** (all closed)

- [x] NOWPayments payout wallet is **self-custody**: Exodus TRON address,
      first/last 6 characters matched against the dashboard, seed on paper only.
      It has received exchange *withdrawals* before; that is fine. What must
      never be used is an **exchange-controlled deposit address**.
- [x] ≥ 31 USDT + ≥ 30 TRX in the same Exodus wallet: 31.83 USDT + 32 TRX.
      Bybit failed (2026-11-08). Funded through **OKX** instead: PIX in BRL →
      spot USDT/TRX → withdrawal on TRON, TRX first.
- [x] `/health/ready` → 200 (2026-11-09 20:30 BRT).

**Verified state at end of §6.7**

- §6.4 (2026-11-09): pre-check ready 200; `.current_tag` `471cefcd…`; api/web
  `healthy`. Fresh login 200, balance 0. 20:31:14 BRT
  `POST /api/payments/checkout/credits` `{"packId":"pro","provider":"crypto"}`
  → `transactionId` `cmw9waf7e00013h92jq9xpde6`, `idempotencyKey`
  `pack_xlba47623u31k1cwnog4p0pt`, `amount 2999 USD`, `status PENDING`,
  `payCurrency usdttrc20`, `payAmount "29.923766"` (string, 6 decimals),
  `payMemo null`, `expiresAt` +19 min. Paid **29.93 USDT** from Exodus on TRC-20
  (rounded **up**), TXID `b096b616…2ecd`. Network cost **4.13 TRX**.
- §6.5: NOWPayments `finished`. AuditLog `payment.charge_created` 20:31:14 →
  `wallet.credited` + `payment.confirmed` 20:36:54 BRT (~5.7 min). Balance
  0 → **1000** ("Pro credit pack — 1000 credits"). Four status IPNs
  (`req-fex`, `req-ffg`, `req-ffi`, `req-ffk`), all 200. Dashboard **Resend
  IPN** → fifth IPN `req-fh4` 200. Balance stays 1000 and the AuditLog is
  unchanged: exactly **one** `wallet.credited`. Idempotency proven, both
  across status transitions and on an exact resend.
- §6.6 (live provider fields, payment `5861924364`): `order_id` = our
  **idempotencyKey**; `order_description` "Pro credit pack — 1000 credits";
  price 29.99 USD; `pay_amount` 29.923766; `actually_paid` 29.93 (overpaid →
  `finished`); `pay_currency` usdttrc20; `payin_extra_id` null; payin hash =
  owner TXID; `type` crypto2crypto; `fixed_rate` false; `fee_paid_by_user`
  false; **service fee 0.2993 (1.0 %)**; outcome 29.6307 USDT; **payout address
  `Balance`** (custodial; payout hash `partner_liab…`). `x-nowpayments-sig`
  HMAC-SHA512 accepted on all 5 signed IPNs; unsigned → 400. No adapter field
  mismatch found, so nothing to send back for an adapter fix.
- §6.7: `jar.txt` removed; `~/visorfans-test` is empty (`700`). 29.6307 USDT
  remain on the NOWPayments custodial balance (deviation 27).

**Verified state at end of §7**

- Pre-checks: origin `soulevil09/creator-platform`; `gh` as `soulevil09`
  (scopes `repo`, `workflow`); ready 200. `api.env` cron secrets are 64 chars each.
- Repo secrets `SUBSCRIPTION_RENEWAL_CRON_SECRET`, `STORAGE_CLEANUP_CRON_SECRET`,
  `RECONCILIATION_CRON_SECRET` and `API_PUBLIC_URL` rewritten through a pipe from
  the droplet (nothing printed). `PAYOUT_CRON_SECRET` (repo, ~1 month old, has no
  counterpart in `api.env`) was left untouched.
- Subscription renewals, Storage cleanup and Reconciliation are `active`; Weekly
  payout is `disabled_manually`. Manual runs `42725364635`, `42725371654` and
  `42725376806` → success. API: `POST /api/subscriptions/renewals/run`,
  `/api/admin/storage/cleanup/run` and `/api/admin/reconciliation/run` → 200.
- Summaries contain counts only. Renewals: `remindersIssued`, `remindersSkipped`,
  `skippedChannelDisabled`, `movedToPastDue/Expired/Canceled` all 0. Cleanup:
  `deleted/skipped/failed` 0. Reconciliation: `generationsReconciled/Skipped`,
  `stalePayoutsFlagged` 0.

**Verified state at end of §8 (2026-11-09 21:10)**

- `.current_tag` `471cefcd…`. `deploy.log`: `2026-10-27T01:28:44Z deployed
  471cefcd…`. api `Up 3 days (healthy)`, web `Up 13 days (healthy)`, caddy
  `Up 13 days` (caddy has **no** Docker healthcheck — deviation 30).
- `docker stats`: api 92.2 MiB / 448, web 76.4 MiB / 384, caddy 13.7 MiB / 64;
  CPU ≈ 0 %.
- Host: disk 24 % of 24 G; RAM 961 Mi total, 421 Mi available; swap 146 Mi /
  2 Gi; no reboot pending; unattended-upgrades active; ufw 22/80/443 (v4 + v6).

**Verified state at end of §9**

- API container: `SENTRY_RELEASE` = `471cefcd960bd8ad84a63a5537a8ae74cde131ac`,
  `SENTRY_ENVIRONMENT` = `production`.
- §9a test event delivered to `visorfans-api` (1 event, **0 users**), then
  resolved.
- Sentry, all projects, all environments, last 30 days: the test event is the
  **only** issue. No Prisma, payment/webhook or `/monitoring` errors. Web
  delivery is not proven yet (open item).

**Pending housekeeping before §4**

- [x] `shred -u /opt/visorfans/env/api.env.save` — not present when checked
      on 2026-10-25; `env/` holds only `api.env` and `compose.env` (`600`,
      `deploy`), home clean.

**Incidents during cutover**

- 2026-10-18: the first Origin CA private key was exposed in a chat transcript
  (newlines were lost when it was stored in a single-line Bitwarden field, so
  `head -1` printed the whole key). The certificate was **revoked** and
  reissued; the new key never left the Mac/droplet/Bitwarden secure note.
- 2026-11-05: `NOWPAYMENTS_IPN_SECRET` in `api.env` did not match the
  dashboard (bad paste during §3). Found by fingerprint comparison, no value
  printed. Secret regenerated 2026-11-06 (no live payment existed yet).
- 2026-11-08: Supabase free project found **paused**; resumed from the
  dashboard. No data loss; only `create-user.js` failed.

**Deviations from the original runbook (to fix in the repo)**

1. GitHub Actions initial state differed from §0: Deploy was disabled and the
   three non-payout crons were enabled. They were disabled by hand. The Deploy
   workflow must be **enabled** at the start of §5.
2. §2: the bootstrap must be run with `ssh -t` (it prompts for the `deploy`
   sudo password; without a TTY the prompt can fail).
3. §2: after bootstrap the droplet reported `*** System restart required ***`.
   Reboot right away, before the 04:30 UTC unattended-upgrade window can
   interrupt §3.
4. §3: the Supabase Connect dialog changed — the pooler string is under
   **Connect → Direct (Connection string) → Session pooler**. The host for
   this project is `aws-1-…`, not `aws-0-…`.
5. §3: added a safe verification script that never prints secret values.
6. §4: the forced-command test needs `-o IdentitiesOnly=yes`, otherwise the
   SSH agent offers the owner key first and the test is meaningless.
7. §4: the DigitalOcean web console may not work for root after hardening;
   host-key pinning is verified against the Mac's existing `known_hosts`
   entry instead (recorded at the first SSH connection).
8. General: never put inline `# comments` after commands meant for the macOS
   zsh prompt (zsh does not treat `#` as a comment interactively).
9. General: store multi-line secrets (keys, certificates) only as Bitwarden
   **Secure Notes** (multi-line Notes field) and copy files with
   `pbcopy < file` / `pbpaste > file`; never `cat`/`head` a key file.
10. §4.1: confirm the prompt is the local macOS shell before generating the
    deploy key (it was once generated on the droplet by mistake and shredded).
11. §4.3: on macOS (OpenSSH 9.x) `ssh-keyscan` writes the `# host:22 SSH-2.0-…`
    line to stdout — filter with `grep -v '^#'` before using the file.
12. §4.4: `NEXT_PUBLIC_MEDIA_ORIGIN` = host of `STORAGE_ENDPOINT`
    (`https://<ref>.storage.supabase.co` here), not `https://<ref>.supabase.co`.
    Fix runbook §4.4 and the comment at `apps/web/Dockerfile:6`.
13. §4.4: archive the CI private key in Bitwarden and prove it with a
    round-trip (`pbpaste > file` → `ssh-keygen -lf` + `cmp`) before deleting it.
14. §4.5: use `read -rs` + `printf | docker login --password-stdin` instead of
    pasting into `--password-stdin` directly (the latter echoes the token).
15. §5.1: `scripts/smoke.ts` reports 2 false FAILs when `app` is
    Cloudflare-proxied. (a) The TLS check (l.138) always connects to the
    droplet IP, so for `app` it receives the Origin CA certificate (not
    publicly trusted) — for proxied hosts it must validate the public edge via
    DNS, and optionally validate the origin against the Cloudflare Origin CA
    root. (b) The "no server header" check must accept exactly
    `server: cloudflare` together with `cf-ray`, while still failing on
    `Caddy`, `x-powered-by` or `via`. The first Deploy run (40432351313) was
    red only because of these two items.
16. §5.1: the Deploy workflow passes an empty `sentry_auth_token` build secret
    when `SENTRY_AUTH_TOKEN` is unset (annotation "not a valid secret"); make
    that step conditional.
17. §5.1: pin the Deploy `sha` input explicitly
    (`gh workflow run deploy.yml --ref main -f sha="$(git rev-parse origin/main)"`)
    and do not push to `main` during the cutover, so the deployed commit is
    deterministic.
18. §5.3: the web app has no login route (home is the "coming soon" page);
    `/admin` and `/wallet` are unreachable from a browser without a manual
    `POST /api/auth/login` from the app origin (done via Web Inspector here).
    Add a `/login` page (i18n, linked from home, error states) before public
    launch.
19. §5.3: the browser console shows the Sentry SDK warning that
    `beforeSendTransaction` / `ignoreTransactions` are ignored with
    `traceLifecycle: 'stream'` (the default). Both `apps/web/src/sentry.shared.ts`
    and `apps/api/src/lib/sentry.ts` scrub transactions through
    `beforeSendTransaction`. If tracing is on (`tracesSampleRate > 0`), span
    data is **not** scrubbed — move scrubbing to `beforeSendSpan` (or set
    `traceLifecycle: 'static'`). Verified 2026-10-30: tracing is **off** in
    both apps (web: `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` unset → 0; api:
    default 0, not set in `api.env` nor in the container), so no spans are
    sent today. Mandatory fix before enabling any tracing.
20. §6.2/§6.4: the NOWPayments `usdttrc20` minimum was 10.78 USDT
    (≈ USD 10.72) on 2026-11-06. `starter` (3.99) and `plus` (9.99) are
    below it, so §6.4's hardcoded `"packId":"plus"` cannot work — the live
    test uses `pro` (29.99). Product issue: any crypto checkout (pack or
    subscription tier) under the provider minimum must be hidden or rejected
    with a clear, i18n error before launch, or prices revised.
21. §3/§6.1: the IPN secret in `api.env` did not match the dashboard. Add a
    fingerprint check to §3.5 and §6.1: `sha256` prefix of the **container**
    value (`docker exec … printenv X | tr -d '\r\n' | sha256sum | cut -c1-12`)
    vs the dashboard value copied to the clipboard
    (`pbpaste | tr -d '\r\n' | shasum -a 256 | cut -c1-12`, run immediately —
    Bitwarden auto-clears the clipboard). Validate `NOWPAYMENTS_API_KEY` with
    the min-amount call (header read from a process substitution, never on
    argv). To change one secret line, use `read -rs` + `awk ENVIRON` into
    `api.env.new`, compare length/hash/line count/keys, then `mv` — not `nano`.
22. General: the Supabase free project **paused** mid-cutover even with the
    API running. Before any DB-dependent step check `/health/ready` = 200.
    Pre-launch blocker: Supabase Pro (no pausing) or guaranteed activity.
23. §6.4: pay from a **self-custody** TRON wallet holding USDT + TRX
    (fee in TRX, exact `payAmount` arrives). With payment covering 0 %, an
    exchange withdrawal that deducts its fee from the amount produces
    `partially_paid`; exchanges also enforce 5–10 USDT minimum withdrawals.
    Never use an exchange deposit address as the NOWPayments payout wallet.
24. §6.3–§6.5: the access token expires in well under an hour (401 ~20 min
    after login). Re-run the login right before checkout and again before the
    balance check. Run it in `~/visorfans-test` (outside any repo,
    `umask 077`); zsh prompt syntax is `read -rs 'p?Senha: '`; use an
    alphanumeric-only password (the JSON is built with `printf`, no escaping).
25. §6.4 prerequisites: raise the TRX buffer from 25 to **≥ 30 TRX**. A sender
    with no staked energy can burn up to ~27 TRX sending USDT to a fresh address
    (the `payAddress`), and the transaction fails before broadcast if TRX is
    short. Actual cost on 2026-11-09 was **4.13 TRX**; keep the buffer anyway.
    Fund TRX before USDT, because the TRX transfer activates and tests the
    address. Self-custody check: the payout address must not be
    **exchange-controlled**; having received exchange withdrawals into it is fine.
    Funding route that worked: **OKX** (PIX → spot → TRON withdrawal). Bybit
    failed for the owner on 2026-11-08. If the wallet cannot enter all 6
    decimals of `payAmount`, round **up**, never down.
26. §6.5: Fastify/pino log `url` on the request line and `statusCode` on the
    response line, so IPN status codes can only be read by joining the two lines
    on `reqId` (see the revised §6.5 command). The **Resend IPN** button is on
    NOWPayments → Payments → payment details. Use it for the
    exact-duplicate idempotency test.
27. §6.5/§6.6: NOWPayments keeps revenue on the **custodial balance**
    (`Payout address: Balance`, payout hash `partner_liab…`); nothing is sent
    automatically to the payout wallet. The runbook's "payout to the payout
    wallet" expectation was wrong for the current account settings. The observed
    service fee is **1.0 %** (0.2993 on 29.93), not the 0.5 % assumed in
    CLAUDE.md. `order_id` = our `idempotencyKey`.
28. §7.2: the step summary is rendered at the top of the run page as
    "Trigger … sweep summary"; there is no step called "Summary". The
    Reconciliation cron covers **AI generations and stale payouts only**. It does
    **not** reconcile pending payments, so §6.5's expectation was wrong.
29. General: never paste terminal **output** back into zsh; copy command blocks
    only. Pasted output gets executed line by line.
30. §8: caddy has **no Docker healthcheck**. `docker inspect
    --format '{{.State.Health.Status}}'` fails with "map has no entry for key
    Health", and `vf ps` shows no `(healthy)` for it. `docker compose up
    --wait` still reports it as "Healthy" once it is running. Either add a
    healthcheck or document that caddy liveness comes from the external
    `/health/ready` check.

**Open items to carry into CLAUDE.md**

- Optional hardening: `/opt/visorfans` is owned by `deploy` (755); consider
  `root:deploy 750`. Not an escalation path today (sudo requires a password;
  `bin/` is root-owned).
- Pin `runs-on: ubuntu-24.04` in all workflows (`ubuntu-latest` migrates to
  Ubuntu 26 from 2026-10-19).
- Caddy memory: 31.8 MiB at §5, **13.7 MiB** at §8 (21 % of 64 MiB). Downgraded
  to watch-only.
- **Pre-launch blocker:** no browser login UI (deviation 18). Add to the
  Session Map.
- Sentry transaction scrubbing under `traceLifecycle: 'stream'`
  (deviation 19) — tracing verified off (rate 0) in api and web; move
  scrubbing to `beforeSendSpan` before any non-zero tracing in production.
- **Pre-launch blocker:** crypto checkout below the NOWPayments minimum
  (deviation 20) — `starter`/`plus` unpayable in crypto today.
- **Pre-launch blocker:** Supabase free-tier pausing (deviation 22) — decide
  on Supabase Pro.
- Product decision: NOWPayments "payment covering" tolerance (0 % today →
  any short payment is `partially_paid`); consider 0.5–1 % before launch.
- ~~Provider shapes still need live verification~~: **done in §6.6**, no
  mismatches.
- **Pre-launch decision:** NOWPayments custody (deviation 27). Choose between
  keeping revenue on the custodial balance with manual withdrawals
  (counterparty risk) and automatic forwarding to the self-custody payout
  wallet (a withdrawal fee each time, because the receiver pays). Currently
  29.6307 USDT sit on the NOWPayments balance.
- **Pre-launch:** update the NOWPayments fee to the observed **1.0 %** in
  CLAUDE.md and in the Session 06 revenue-share assumptions. Confirm the rate
  against the account's fee plan.
- **Pre-launch:** there is no payment reconciliation sweep (deviation 28). A
  `PENDING` charge whose IPNs are all lost is recovered only by NOWPayments
  retries or a manual dashboard **Resend IPN**. Either add a sweep that calls
  `GET /v1/payment/{id}` for stale charges, or document the manual procedure.
- `PAYOUT_CRON_SECRET` repo secret is stale (it predates production and has no
  `api.env` counterpart). When Paxum goes live, generate it in `api.env` and
  re-sync it with the §7.1 pipe.
- Sentry web delivery is unproven in production: zero web events in 30 days.
  Send one browser test event through `/monitoring` before launch, and apply the
  §9 PII checklist to the first **real** error event in each project.
- Caddy healthcheck (deviation 30): add one or document the external check.
- §6.4 leftovers on the owner's Exodus wallet: ~1.90 USDT + 19.44 TRX.

---

**Topology.** One DigitalOcean droplet (`visorfans-prod`, NYC1, Ubuntu 24.04)
runs Docker Compose: **Caddy** (the only thing listening on 80/443) → **api**
(Fastify) and **web** (Next.js) on an internal network `172.30.0.0/24`. Postgres
is Supabase (`us-east-2`), reached outbound only. Images are built by GitHub
Actions for `linux/amd64` and pulled from GHCR. Nothing is ever built on the
droplet.

| Host                   | Cloudflare                 | TLS                                                   | Upstream         |
| ---------------------- | -------------------------- | ----------------------------------------------------- | ---------------- |
| `app.visorfans.com`    | **Proxied** (orange)       | Cloudflare Origin CA cert, SSL mode **Full (strict)** | `web:3000`       |
| `api.visorfans.com`    | **DNS only** (grey)        | Let's Encrypt, automatic (Caddy)                      | `api:4000`       |
| `visorfans.com` (apex) | unchanged — Vercel landing | —                                                     | **do not touch** |

**Numbers to know**

| What                   | Value                                                                                                                                                                                                            | Where                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Upload ceiling (API)   | `CONTENT_UPLOAD_MAX_BYTES` = **64 MiB** (67,108,864 B); boot fails above 96 MiB                                                                                                                                  | `api.env`                        |
| Upload ceiling (proxy) | Caddy `request_body max_size` = **70 MiB** (limit + ~6 MiB multipart margin)                                                                                                                                     | `infra/Caddyfile`                |
| Trusted proxy range    | `TRUST_PROXY=172.30.0.0/24` — the pinned compose subnet. **Never** `true`, **never** a hop count like `1` (fastify ≥ 5.12.5 treats a number as "trust nothing" — every client would share one rate-limit budget) | `api.env` + `infra/compose.yaml` |
| Memory limits          | caddy 64m · api 448m (heap 256 MiB) · web 384m (heap 256 MiB) · migrate 256m                                                                                                                                     | `infra/compose.yaml`             |
| Expected idle RSS      | caddy ~20 MiB · api ~150 MiB · web ~110 MiB (see §8)                                                                                                                                                             | `docker stats`                   |
| Deploy downtime        | ~10–20 s (sequential restart; target ≤ 30 s)                                                                                                                                                                     | `deploy.sh`                      |

Raising the upload limit for video needs **streaming multipart uploads** first
(Open Item) — uploads are buffered whole in memory today.

---

## 0. Before you start

- A machine with `ssh`, `openssl`, `curl`, `gh` (optional). Check with
  `ssh -V`, `openssl version`, `curl --version`.
- Bitwarden open (the 7 secrets), the Sentry DSNs, and the NOWPayments API key
  and IPN secret. Also the Supabase DB password and Storage S3 keys (§3).
- The droplet's public IPv4 (`<IP>` below) and your SSH key already on it.
- GitHub Actions: **CI** enabled; **Deploy** and all four cron workflows
  (Subscription renewals, Storage cleanup, Reconciliation, Weekly payout)
  **disabled** (workflow → `···` → Disable workflow). Deploy is enabled in §5.

---

## 1. Cloudflare DNS + certificates

1. **DNS** (Cloudflare → `visorfans.com` → DNS → Records):
   - `A app <IP>` — **Proxied**.
   - `A api <IP>` — **DNS only**. Caddy must answer the Let's Encrypt HTTP-01
     challenge itself, and API clients must reach the droplet directly (real
     client IPs for rate limits; WebSockets; no 100 MB proxy cap).
   - Leave the apex `A @ 76.76.21.21` and anything else **untouched**.
2. **SSL mode Full (strict) for the app host only** (preferred): Rules →
   Create rule → **Configuration Rule** → name `app full strict` → Custom
   filter expression _Hostname equals `app.visorfans.com`_ → SSL → **Full
   (strict)** → Deploy. Do not change the zone-wide SSL mode.
3. **Origin CA certificate** (SSL/TLS → Origin Server → Create certificate):
   key type ECC or RSA, hostnames **`app.visorfans.com` only** (remove the
   default `*.visorfans.com` and `visorfans.com`), validity 15 years.
4. Save both files on your machine **outside any repo**, straight from the
   Cloudflare copy buttons (the key is shown once):

   ```bash
   mkdir -p ~/visorfans-certs && chmod 700 ~/visorfans-certs
   cd ~/visorfans-certs
   pbpaste > app.pem
   pbpaste > app.key && chmod 600 app.key
   echo -n | pbcopy
   ```

   Keep a copy as a Bitwarden **Secure Note** (multi-line Notes field).

5. Verify without printing the key:

   ```bash
   wc -l app.pem app.key
   openssl x509 -in app.pem -noout -subject -enddate
   openssl x509 -in app.pem -noout -ext subjectAltName
   openssl pkey -in app.key -noout && echo "key OK"
   openssl x509 -in app.pem -noout -pubkey | openssl sha256
   openssl pkey -in app.key -pubout | openssl sha256
   dig +short app.visorfans.com
   dig +short api.visorfans.com
   dig +short visorfans.com
   ```

   Expect multi-line files, SAN `DNS:app.visorfans.com` only, identical
   hashes, Cloudflare IPs for `app`, `<IP>` for `api`, `76.76.21.21` for the
   apex.

---

## 2. Droplet bootstrap (once, as root)

1. Create the `deploy` sudo password in Bitwarden first. Confirm the
   DigitalOcean cloud firewall allows inbound TCP 22/80/443.
2. Terminal A: `ssh root@<IP>` and leave it open, idle (safety net).
3. Terminal B, in the repo root (`git status` clean apart from session specs):

   ```bash
   scp -r infra root@<IP>:/root/visorfans-infra
   ssh -t root@<IP> 'bash /root/visorfans-infra/bootstrap.sh'
   ```

The script is idempotent. It installs Docker from Docker's apt repo, adds 2 GB
swap (`vm.swappiness=10`), creates the `deploy` user (docker group; sudo **with
a password** — it prompts you to set one), copies your key from
`/root/.ssh/authorized_keys`, enables unattended security upgrades (reboot
window 04:30 UTC), mirrors the cloud firewall in `ufw` (22/80/443), creates
`/opt/visorfans/{env,certs,bin,releases}` and installs the root-owned
`deploy.sh` / `deploy-gate`. **Only then** does it disable root login and
password authentication — and it refuses to if `deploy` has no key.

4. Terminal C: `ssh deploy@<IP>`, then:

   ```bash
   whoami
   docker version --format '{{.Server.Version}}'
   free -h | grep -i swap
   sudo ufw status
   ls -la /opt/visorfans
   cat /etc/docker/daemon.json
   ```

   `daemon.json` must contain `"userland-proxy": false`.

5. Only after step 4 works: `ssh root@<IP>` must answer
   `Permission denied (publickey)`. Then close Terminal A.
6. **Reboot now** if `cat /var/run/reboot-required` prints anything:
   `sudo reboot`, wait a minute, reconnect.

Optional, on your machine — keepalive so idle sessions do not drop (a dropped
session leaves `nano` emergency files such as `api.env.save` behind):

```bash
cat >> ~/.ssh/config <<'EOF'

Host visorfans
  HostName <IP>
  User deploy
  ServerAliveInterval 30
  ServerAliveCountMax 4
EOF
```

---

## 3. Environment files (as `deploy`)

All files are `chmod 600`, owned by `deploy`, outside any repo. The bootstrap
creates both files empty. Edit them **on the droplet** with `nano` (check the
prompt reads `deploy@visorfans-prod`).

1. `/opt/visorfans/env/compose.env` — compose interpolation:

   ```bash
   GHCR_OWNER=soulevil09
   API_TLS=contato@visorfans.com
   # optional, default to the production hosts:
   # API_HOST=api.visorfans.com
   # APP_HOST=app.visorfans.com
   ```

2. **Supabase connection string.** The droplet is IPv4-only and Supabase's
   direct host (`db.<ref>.supabase.co`) is IPv6-only, so use the **Supavisor
   session pooler**: Supabase → **Connect → Direct (Connection string) →
   Session pooler** (port **5432**, user `postgres.<ref>`, host like
   `aws-1-us-east-2.pooler.supabase.com` — copy it, do not guess). Replace
   `[YOUR-PASSWORD]` including the brackets; URL-encode `@ : / ? # %` in the
   password. Session mode supports everything Prisma needs, including
   `migrate deploy`. Do **not** use the transaction pooler (6543) for
   migrations. Append `?connection_limit=5&pool_timeout=20&sslmode=require`.

   Free projects **pause after ~7 days without activity**. A paused project
   makes `/health/ready` answer 503 and makes a deploy abort at the migration
   step (safe — nothing changes). Resume it in the dashboard, wait 30–60 s,
   and redeploy.

3. `/opt/visorfans/env/api.env` — fill from Bitwarden. For this deploy only
   the crypto channel is live; everything else is `disabled`:

   ```bash
   NODE_ENV=production
   DATABASE_URL=postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres?connection_limit=5&pool_timeout=20&sslmode=require

   # Auth — two different values, ≥ 32 chars each (openssl rand -hex 32)
   JWT_SECRET=
   JWT_REFRESH_SECRET=

   # URLs — https, same registrable domain (boot fails otherwise)
   APP_URL=https://app.visorfans.com
   API_PUBLIC_URL=https://api.visorfans.com

   # Exactly the compose subnet — a CIDR, never `true`, never a hop count
   TRUST_PROXY=172.30.0.0/24

   # Anti-leak + cron secrets (same values as the GitHub Actions secrets)
   WATERMARK_TRACE_SECRET=
   SUBSCRIPTION_RENEWAL_CRON_SECRET=
   STORAGE_CLEANUP_CRON_SECRET=
   RECONCILIATION_CRON_SECRET=

   # Provider channels: crypto live, everything else OFF (never `mock` in prod)
   PAYMENT_PROVIDER_CRYPTO=nowpayments
   NOWPAYMENTS_API_KEY=
   NOWPAYMENTS_IPN_SECRET=
   PAYMENT_PROVIDER_PIX=disabled
   PAYMENT_PROVIDER_CARD=disabled
   PAYOUT_PROVIDER=disabled
   AI_PROVIDER=disabled
   EMAIL_PROVIDER=disabled

   # Storage (Supabase Storage, S3 connection)
   STORAGE_ENDPOINT=https://<ref>.supabase.co/storage/v1/s3
   STORAGE_BUCKET=
   STORAGE_ACCESS_KEY=
   STORAGE_SECRET_KEY=
   STORAGE_REGION=us-east-2

   # Uploads (buffered in memory — see the table at the top)
   CONTENT_UPLOAD_MAX_BYTES=67108864

   # Monitoring
   SENTRY_DSN=<visorfans-api DSN>
   SENTRY_ENVIRONMENT=production
   ```

   Not needed while their channel is disabled: `OPENPIX_*`, `PAXUM_*`,
   `PAYOUT_CRON_SECRET`, `AI_PROVIDER_API_KEY`, `EMAIL_API_KEY`. The API
   refuses to boot if a value is missing for an **enabled** channel, if any
   channel says `mock`, or if `EMAIL_PROVIDER=resend` (Resend's AUP bars adult
   businesses).

   `NEXT_PUBLIC_MEDIA_ORIGIN` is **not** a runtime variable: it is baked into
   the web image at build time (§4, GitHub variable).

4. **Origin certificate.** From your machine:

   ```bash
   scp ~/visorfans-certs/app.pem ~/visorfans-certs/app.key deploy@<IP>:~/
   ```

   On the droplet:

   ```bash
   sudo install -m 640 -o root -g deploy ~/app.pem /opt/visorfans/certs/app.pem
   sudo install -m 640 -o root -g deploy ~/app.key /opt/visorfans/certs/app.key
   shred -u ~/app.pem ~/app.key
   ```

5. **Verify** (prints names and non-secret values only):

   ```bash
   cd /opt/visorfans/env
   ls -la
   grep -E '^[A-Z_]+=' api.env | cut -d= -f1
   echo "invalid lines: $(grep -vE '^(#|$|[A-Z_]+=)' api.env | wc -l)"
   grep -E '^[A-Z_]+=$' api.env compose.env || echo "no empty values"
   echo "brackets in URL: $(grep '^DATABASE_URL=' api.env | grep -c '\[')"
   awk -F= '/^JWT_/{print $1, "len=" length($2)}' api.env
   [ "$(grep '^JWT_SECRET=' api.env | cut -d= -f2-)" != "$(grep '^JWT_REFRESH_SECRET=' api.env | cut -d= -f2-)" ] && echo "JWT distinct OK"
   grep -E '^(TRUST_PROXY|NODE_ENV|APP_URL|API_PUBLIC_URL|PAYMENT_PROVIDER_|PAYOUT_PROVIDER|AI_PROVIDER|EMAIL_PROVIDER|CONTENT_UPLOAD|STORAGE_REGION|SENTRY_ENVIRONMENT)' api.env
   grep -oE '@[^/]+:[0-9]+/[^?]+\?.*' api.env
   sudo ls -la /opt/visorfans/certs
   sudo openssl x509 -in /opt/visorfans/certs/app.pem -noout -ext subjectAltName
   ```

   Only `api.env` and `compose.env` may exist in `env/` — `shred -u` any
   `*.save` file left by `nano`.

---

## 4. Deploy key, GitHub environment, GHCR

1. **A dedicated deploy key** (on your machine — not your personal key):

   ```bash
   mkdir -p ~/visorfans-ci && chmod 700 ~/visorfans-ci
   ssh-keygen -t ed25519 -N '' -C ci-deploy -f ~/visorfans-ci/visorfans-ci-deploy
   ```

2. **Forced command** — append to `/home/deploy/.ssh/authorized_keys`:

   ```bash
   echo "command=\"/opt/visorfans/bin/deploy-gate\",restrict $(cat ~/visorfans-ci/visorfans-ci-deploy.pub)" \
     | ssh deploy@<IP> 'cat >> ~/.ssh/authorized_keys'
   ```

   `restrict` removes forwarding, PTY and environment passing; `deploy-gate`
   accepts only `deploy <hex sha>`. Test it (`IdentitiesOnly` is required,
   otherwise your agent's personal key is tried first):

   ```bash
   ssh -i ~/visorfans-ci/visorfans-ci-deploy -o IdentitiesOnly=yes deploy@<IP> whoami
   ```

   must print `deploy-gate: refused`. Then
   `ssh deploy@<IP> 'whoami; grep -c . ~/.ssh/authorized_keys'` must print
   `deploy` and `2` (owner key + CI key).

3. **Pinned host key.** On the droplet:
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. On your machine:

   ```bash
   cd ~/visorfans-ci
   ssh-keyscan -t ed25519 <IP> > known_hosts
   ssh-keygen -lf known_hosts
   ssh-keygen -lF <IP> | grep -i ed25519
   ```

   All three `SHA256:` fingerprints must match. The last one comes from your
   existing `~/.ssh/known_hosts` (first connection to the droplet) and is the
   independent check; the DigitalOcean web console can be used too if it still
   accepts a login.

4. **GitHub → Settings → Environments → `production`** (add required
   reviewers if you want a manual gate):
   - Secrets: `DEPLOY_SSH_KEY` (the private key file), `DEPLOY_HOST` (`<IP>`),
     `DEPLOY_KNOWN_HOSTS` (the verified line), optionally `SENTRY_AUTH_TOKEN`
     (source-map upload; scope: project releases). Copy files without
     printing them: `pbcopy < ~/visorfans-ci/visorfans-ci-deploy`,
     `pbcopy < ~/visorfans-ci/known_hosts`, then `echo -n | pbcopy`.
   - Variables: `APP_URL=https://app.visorfans.com`,
     `API_URL=https://api.visorfans.com`,
     `NEXT_PUBLIC_MEDIA_ORIGIN=https://<ref>.supabase.co`,
     `NEXT_PUBLIC_SENTRY_DSN=<visorfans-web DSN>`, optionally `SENTRY_ORG`,
     `SENTRY_PROJECT_WEB=visorfans-web`.
   - Changing any `NEXT_PUBLIC_*` value needs a new image: re-run Deploy.
   - Save the private key as a Bitwarden Secure Note, then
     `rm ~/visorfans-ci/visorfans-ci-deploy`.

5. **GHCR pull token on the droplet** (CI never sends it). GitHub → Settings →
   Developer settings → Personal access tokens (classic) → scope
   **`read:packages` only**, 1-year expiry (calendar reminder). As `deploy`:

   ```bash
   docker login ghcr.io -u soulevil09 --password-stdin
   ```

   Paste the token, Enter, Ctrl-D → `Login Succeeded`. It is stored in
   `/home/deploy/.docker/config.json` (must be mode 600).

---

## 5. First deploy + admin

0. GitHub → Actions → **Deploy** → `···` → **Enable workflow**. Make sure the
   Supabase project is not paused.
1. GitHub → Actions → **Deploy** → _Run workflow_ (leave `sha` empty → head of
   `main`). It builds both images (amd64), pushes them to GHCR, runs
   `deploy <sha>` on the droplet (pull → migrate → up → health → ready), then
   runs `scripts/smoke.ts` against production.
   - First run: Caddy obtains the Let's Encrypt certificate for the api host
     on the first request (a few seconds).
   - The GHCR packages are created **private** — leave them private.
2. **Real client IPs.** From your laptop: `curl -s https://api.visorfans.com/health`,
   then on the droplet:

   ```bash
   cd /opt/visorfans/releases/$(cat /opt/visorfans/.current_tag)
   IMAGE_TAG=$(cat /opt/visorfans/.current_tag) docker compose --env-file /opt/visorfans/env/compose.env logs api | grep '"url":"/health"' | tail -1
   ```

   `remoteAddress` must be **your public IP**, not `172.30.0.x`. If it is
   `172.30.0.1`, Docker's userland proxy is in the path — check
   `/etc/docker/daemon.json` has `"userland-proxy": false` and restart Docker.

3. **Admin account** (registration is closed while email is disabled):

   ```bash
   docker exec -it visorfans-api-1 node dist/scripts/ops/create-user.js \
     --role admin --email you@example.com --display-name "Ops"
   ```

   It prompts twice for the password (hidden) and prints only the new user id.
   Then log in at `POST /api/auth/login` and open `https://app.visorfans.com/admin`.
   **Approve nothing yet.**

---

## 6. NOWPayments: IPN + one live payment

> Revised 2026-11-08 after §6.1–§6.3 (deviations 20–24). Before any step that
> touches the DB: `curl -s -o /dev/null -w '%{http_code}\n' https://api.visorfans.com/health/ready`
> must print `200` (a paused Supabase project prints `503` — resume it, wait
> 30–60 s).

1. **IPN.** NOWPayments dashboard → Store Settings → IPN: callback URL
   **`https://api.visorfans.com/api/payments/nowpayments/webhook`** (each
   payment also carries it as `ipn_callback_url`). Check the route rejects
   unsigned calls (expect `400`):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' https://api.visorfans.com/api/payments/nowpayments/webhook
   ```

   **Fingerprint check** — the IPN secret in the running container must equal
   the dashboard. Droplet:

   ```bash
   docker exec visorfans-api-1 printenv NOWPAYMENTS_IPN_SECRET | tr -d '\r\n' | sha256sum | cut -c1-12
   ```

   Mac, right after copying the secret from the dashboard:

   ```bash
   pbpaste | tr -d '\r\n' | shasum -a 256 | cut -c1-12
   echo -n | pbcopy
   ```

   Prefixes must match. If not, regenerate in the dashboard, save to
   Bitwarden, and rewrite only that line (no echo, no `nano`):

   ```bash
   cd /opt/visorfans/env
   umask 077
   read -rs NPSEC
   export NPSEC
   awk 'BEGIN{d=0} /^NOWPAYMENTS_IPN_SECRET=/{print "NOWPAYMENTS_IPN_SECRET=" ENVIRON["NPSEC"]; d=1; next} {print} END{if(!d) exit 1}' api.env > api.env.new && echo "rewrite OK"
   unset NPSEC
   grep '^NOWPAYMENTS_IPN_SECRET=' api.env.new | cut -d= -f2- | tr -d '\r\n' | sha256sum | cut -c1-12
   wc -l api.env api.env.new
   diff <(cut -d= -f1 api.env) <(cut -d= -f1 api.env.new) && echo "same keys"
   mv api.env.new api.env && chmod 600 api.env
   vf up -d --no-deps --force-recreate api
   ```

2. **API key + minimum amount** (key read from a process substitution — never
   on argv, never printed). `PAYOUT` = currency of the store's payout wallet:

   ```bash
   PAYOUT=usdttrc20
   curl -s -H @<(printf 'x-api-key: %s\n' "$(docker exec visorfans-api-1 printenv NOWPAYMENTS_API_KEY)") "https://api.nowpayments.io/v1/min-amount?currency_from=usdttrc20&currency_to=${PAYOUT}&fiat_equivalent=usd"; echo
   ```

   Pick the smallest pack whose price is comfortably above `fiat_equivalent`
   (`starter` 3.99, `plus` 9.99, `pro` 29.99). On 2026-11-06 the minimum was
   ≈ USD 10.72 → **`pro`**.

3. **Test subscriber + login** (no password on any command line; password
   alphanumeric only). On the droplet:

   ```bash
   docker exec -it visorfans-api-1 node dist/scripts/ops/create-user.js --role subscriber --email contato+buyer@visorfans.com --display-name "Test buyer"
   ```

   On the Mac (zsh), **outside any repo**:

   ```bash
   mkdir -p ~/visorfans-test && chmod 700 ~/visorfans-test && cd ~/visorfans-test
   umask 077
   read -rs 'p?Senha: '
   ```

   ```bash
   printf '{"email":"%s","password":"%s"}' 'contato+buyer@visorfans.com' "$p" > login.json
   unset p
   curl -s -c jar.txt -H 'content-type: application/json' --data @login.json https://api.visorfans.com/api/auth/login -o /dev/null -w '%{http_code}\n'
   rm login.json
   awk -F'\t' 'NF>=7{print $1, $6}' jar.txt
   curl -s -b jar.txt https://api.visorfans.com/api/wallet/balance; echo
   ```

   Expect `200`, cookie names `access_token` + `refresh_token`
   (`#HttpOnly_api.visorfans.com`), balance `0`. The access token is
   short-lived: **repeat this login right before step 4 and before step 5.**

4. **Checkout + payment.** Prerequisites: USDT + TRX in a **self-custody**
   TRON wallet; the payout wallet is self-custody; `/health/ready` = 200; a
   fresh login (step 3). Then:

   ```bash
   cd ~/visorfans-test
   curl -s -b jar.txt -H 'content-type: application/json' -d '{"packId":"pro","provider":"crypto"}' https://api.visorfans.com/api/payments/checkout/credits; echo
   ```

   The answer has `payment.payAddress`, `payment.payAmount`,
   `payment.payCurrency`. Check `payCurrency` is USDT on TRON. From the
   self-custody wallet send **exactly** `payAmount` USDT on **TRC-20** to
   `payAddress` (copy/paste both; check first/last 4 characters of the
   address). The network fee is paid in TRX. Do it promptly, because the
   charge expires about **19 min** after creation (`expiresAt`). Never pay from
   an exchange that deducts its fee from the amount (payment covering is 0 % →
   `partially_paid`). If the wallet cannot enter all 6 decimals, round
   **up**; overpaying slightly still ends as `finished`. Wallet prerequisites:
   ≥ `payAmount` + 1 USDT and **≥ 30 TRX** (deviation 25).

5. **Confirm** (after the network confirmations, ~5–6 min end to end; re-login
   first):
   - `curl -s -b jar.txt https://api.visorfans.com/api/wallet/balance` → credits added once.
   - Supabase SQL editor:
     `select action, "entityId", "createdAt" from "AuditLog" where action like 'payment.%' or action like 'wallet.%' order by "createdAt" desc limit 10;`
     → `payment.charge_created`, then `wallet.credited` + `payment.confirmed`
     (exactly one `wallet.credited`).
   - IPN status codes. Fastify logs `url` and `statusCode` on separate lines,
     so join them on `reqId` (droplet):

     ```bash
     vf logs --no-log-prefix --since 90m api | awk '/nowpayments\/webhook/{if(match($0,/"reqId":"?[^,"]+"?/)) id[substr($0,RSTART,RLENGTH)]=1} /"statusCode"/{if(match($0,/"reqId":"?[^,"]+"?/)){r=substr($0,RSTART,RLENGTH); if(r in id){match($0,/"statusCode":[0-9]+/); print r, substr($0,RSTART,RLENGTH)}}}'
     ```

     Expect one `200` per status transition (4 on 2026-11-09).
   - NOWPayments dashboard → Payments: status `finished`. With the current
     account settings the outcome stays on the **custodial balance**
     (`Payout address: Balance`). Nothing reaches the payout wallet
     automatically (deviation 27).
   - **Idempotency:** NOWPayments → Payments → payment details → **Resend
     IPN**. Re-run the log command (one more `200`), the balance check (unchanged)
     and the AuditLog query (still exactly one `wallet.credited`).
6. **Record what the live payment confirmed**: `pay_address`, `pay_amount`,
   `pay_currency`, `payin_extra_id`, `order_id`, the `x-nowpayments-sig`
   HMAC-SHA512 scheme, plus `actually_paid`, service fee, outcome and payout
   address from the payment details page. Note any field that differed and send
   it back for an adapter fix. (Done 2026-11-09: no mismatch; values are in the
   progress log.)
7. `rm ~/visorfans-test/jar.txt`.

---

## 7. Re-enable the crons

1. GitHub → Settings → Secrets → Actions: `API_PUBLIC_URL=https://api.visorfans.com`
   and the cron secrets equal to the `api.env` values. GitHub secrets cannot
   be read back, so (re)write them straight from the droplet through a pipe
   (never printed). Mac, in the repo root, after `/health/ready` = 200:

   ```bash
   gh auth status
   ssh deploy@146.190.69.232 "awk -F= '/^(SUBSCRIPTION_RENEWAL|STORAGE_CLEANUP|RECONCILIATION)_CRON_SECRET=/{print \$1, length(\$2)}' /opt/visorfans/env/api.env"
   for n in SUBSCRIPTION_RENEWAL_CRON_SECRET STORAGE_CLEANUP_CRON_SECRET RECONCILIATION_CRON_SECRET; do ssh deploy@146.190.69.232 "grep '^${n}=' /opt/visorfans/env/api.env | cut -d= -f2- | tr -d '\r\n'" | gh secret set "$n"; done
   printf '%s' 'https://api.visorfans.com' | gh secret set API_PUBLIC_URL
   gh secret list
   ```

   All three lengths must be > 0 before the loop runs. `PAYOUT_CRON_SECRET`
   stays out (Weekly payout stays disabled).
2. Actions → enable **Subscription renewals**, **Storage cleanup**,
   **Reconciliation**; run each once by hand and check the step summary shows
   counts (no ids). They send no body and no Content-Type. From the repo root:

   ```bash
   gh workflow enable "Subscription renewals"
   gh workflow enable "Storage cleanup"
   gh workflow enable "Reconciliation"
   gh workflow list --all
   gh workflow run "Subscription renewals" --ref main
   gh workflow run "Storage cleanup" --ref main
   gh workflow run "Reconciliation" --ref main
   ```

   After ~90 s, run `gh run list --limit 6`. The summary is shown at the top of
   each run page as "Trigger … sweep summary" (deviation 28). Reconciliation
   covers AI generations and stale payouts only, **not** pending payments.
   On the droplet, the same `reqId` join (§6.5) without the webhook filter
   shows `POST /api/subscriptions/renewals/run`,
   `/api/admin/storage/cleanup/run` and `/api/admin/reconciliation/run` → 200.
3. **Keep "Weekly payout" disabled.** With `PAYOUT_PROVIDER=disabled` it
   would answer 503 `payouts_disabled` anyway; enable it only with Paxum live.
4. While email is disabled, the renewal sweep **issues renewal charges
   without notifying subscribers** (`remindersSkipped` in its summary) — a
   known Open Item until a Mailgun/SES adapter ships.

---

## 8. Operations

**Where things are:** `/opt/visorfans/.current_tag` (live sha),
`/opt/visorfans/releases/<sha>/` (that release's compose + Caddyfile),
`/opt/visorfans/deploy.log`.

A compose shortcut for the live release (put it in `~/.bashrc` on the droplet):

```bash
vf() { local t; t=$(cat /opt/visorfans/.current_tag); IMAGE_TAG=$t docker compose \
  --env-file /opt/visorfans/env/compose.env -f /opt/visorfans/releases/$t/compose.yaml "$@"; }
```

Usage:

```bash
vf ps
vf logs -f api
docker stats --no-stream
tail -50 /opt/visorfans/deploy.log
```

**Rollback.** Either GitHub → Actions → Deploy → Run workflow with the older
`sha`, or on the droplet: `/opt/visorfans/bin/deploy.sh <older-sha>`. A deploy
whose health check fails rolls back to the previous sha automatically.
Migrations are forward-only: the older code runs against the newer schema, so
every migration must stay backward-compatible for one release.

**Resize to 2 GB (at launch).** DigitalOcean → droplet → Resize → _CPU and RAM
only_ (keeps the disk, so it stays reversible) → power off, resize, power on.
Containers come back by themselves (`restart: unless-stopped`). The limits in
`compose.yaml` do not need to change; raise them only if `docker stats` shows a
service near its limit.

**Memory at idle / during a smoke run** (measured on the local stack, arm64 —
expect similar on amd64): see the table in the Session 13 summary;
`docker stats` should show api < 200 MiB, web < 150 MiB, caddy < 30 MiB.
Production on 2026-11-09: api 92 MiB, web 76 MiB, caddy 14 MiB.

**Caddy has no Docker healthcheck** (deviation 30): `vf ps` shows no
`(healthy)` for it, and `docker inspect … .State.Health` fails. Its liveness is
covered by the external `/health/ready` check through Caddy.

---

## 9. Sentry — the first 48 hours

- **Release:** events carry the git sha; confirm both projects show the
  deployed sha.
- **What should be there:** nothing, ideally. Only 5xx/unhandled errors are
  reported — a 4xx never is.
- **Worth acting on:** Prisma connection errors (pooler limits, paused
  project), `payment`/`webhook` errors from the NOWPayments IPN path, anything
  from `/monitoring`.
- **Check one event by hand for PII:** no `email`, `ip_address`, cookies,
  `authorization`, request bodies or query strings must appear. If one does,
  that is a scrubber bug — report it.
- **The `/monitoring` tunnel** forwards browser events **only** to the
  `visorfans-web` project named in the build's DSN; the destination is never
  taken from the request (the stock `tunnelRoute` was an open relay and is not
  used). Junk sent to it can only cost Sentry quota, which Sentry rate-limits
  per project.
- **Test event:** see §9a.

### 9a. Sending one test event

```bash
docker exec visorfans-api-1 node --input-type=module -e "
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN, environment: 'production', release: process.env.SENTRY_RELEASE });
Sentry.captureException(new Error('Session 13 test event — safe to resolve'));
await Sentry.flush(5000);"
```

Done 2026-11-09: delivered to `visorfans-api` (1 event, 0 users) and resolved.
The web project has not received any event yet, so web delivery through
`/monitoring` is still unproven (open item).

This proves delivery (DSN, network, release tag); it bypasses the app's own
init, so it carries no request data by construction. The scrubber itself is
proven by the test suites — still apply the PII checklist above to the first
_real_ error event.
