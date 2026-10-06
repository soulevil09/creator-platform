# Production runbook — visorfans (Session 13, Part B)

Step-by-step cutover for the owner. Claude Code wrote and tested the code
(Part A); everything below touches production and is executed by you.

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

- A machine with `ssh`, `openssl`, `curl`, `gh` (optional).
- Bitwarden open (the 7 secrets), the Sentry DSNs, and the NOWPayments API key
  and IPN secret.
- The droplet's public IPv4 (`<IP>` below) and your SSH key already on it.
- Disable nothing yet — the four cron workflows are already disabled in GitHub.

---

## 1. Cloudflare DNS + certificates

1. **DNS** (Cloudflare → `visorfans.com` → DNS → Records):
   - `A app <IP>` — **Proxied**.
   - `A api <IP>` — **DNS only**. Caddy must answer the Let's Encrypt HTTP-01
     challenge itself, and API clients must reach the droplet directly (real
     client IPs for rate limits; WebSockets; no 100 MB proxy cap).
   - Leave the apex `A @ 76.76.21.21` and anything else **untouched**.
2. **SSL mode Full (strict)** for the app host. Either SSL/TLS → Overview →
   **Full (strict)** for the zone (the apex is DNS-only, so it is unaffected),
   or — narrower — Rules → Configuration Rules → _Hostname equals
   `app.visorfans.com`_ → SSL: Full (strict).
3. **Origin CA certificate** (SSL/TLS → Origin Server → Create certificate):
   key type ECC or RSA, hostnames **`app.visorfans.com` only**, validity 15
   years. Copy the certificate and the private key (the key is shown once).
4. They are installed on the droplet in §3 step 4 as
   `/opt/visorfans/certs/app.pem` and `/opt/visorfans/certs/app.key`.

---

## 2. Droplet bootstrap (once, as root)

```bash
# from your machine, in the repo root
scp -r infra root@<IP>:/root/visorfans-infra
ssh root@<IP> 'bash /root/visorfans-infra/bootstrap.sh'
```

The script is idempotent. It installs Docker from Docker's apt repo, adds 2 GB
swap (`vm.swappiness=10`), creates the `deploy` user (docker group; sudo **with
a password** — it prompts you to set one), copies your key from
`/root/.ssh/authorized_keys`, enables unattended security upgrades (reboot
window 04:30 UTC), mirrors the cloud firewall in `ufw` (22/80/443), creates
`/opt/visorfans/{env,certs,bin,releases}` and installs the root-owned
`deploy.sh` / `deploy-gate`. **Only then** does it disable root login and
password authentication — and it refuses to if `deploy` has no key.

**Before closing the root session**, in a new terminal: `ssh deploy@<IP>` must
work. If it does not, fix it from the still-open root session (or the
DigitalOcean web console).

---

## 3. Environment files (as `deploy`)

All files are `chmod 600`, owned by `deploy`, outside any repo.

1. `/opt/visorfans/env/compose.env` — compose interpolation:

   ```bash
   GHCR_OWNER=soulevil09
   API_TLS=<your email for Let's Encrypt expiry notices>
   # optional, default to the production hosts:
   # API_HOST=api.visorfans.com
   # APP_HOST=app.visorfans.com
   ```

2. **Supabase connection string.** The droplet is IPv4-only and Supabase's
   direct host (`db.<ref>.supabase.co`) is IPv6-only, so use the **Supavisor
   session pooler**: Supabase → Connect → _Session pooler_ (port **5432**,
   user `postgres.<ref>`, host like `aws-0-us-east-2.pooler.supabase.com` —
   copy it, do not guess). Session mode supports everything Prisma needs,
   including `migrate deploy`. Do **not** use the transaction pooler (6543)
   for migrations. Append `?connection_limit=5&pool_timeout=20&sslmode=require`.

   Free projects **pause after ~7 days without activity**. A paused project
   makes `/health/ready` answer 503 and makes a deploy abort at the migration
   step (safe — nothing changes). Resume it in the dashboard and redeploy.

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

4. **Origin certificate** (as root or with sudo):

   ```bash
   sudo install -m 640 -o root -g deploy app.pem /opt/visorfans/certs/app.pem
   sudo install -m 640 -o root -g deploy app.key /opt/visorfans/certs/app.key
   ```

---

## 4. Deploy key, GitHub environment, GHCR

1. **A dedicated deploy key** (on your machine — not your personal key):

   ```bash
   ssh-keygen -t ed25519 -N '' -C ci-deploy -f visorfans-ci-deploy
   ```

2. **Forced command** — append to `/home/deploy/.ssh/authorized_keys` on the
   droplet, on ONE line:

   ```text
   command="/opt/visorfans/bin/deploy-gate",restrict ssh-ed25519 AAAA…(visorfans-ci-deploy.pub)… ci-deploy
   ```

   `restrict` removes forwarding, PTY and environment passing; `deploy-gate`
   accepts only `deploy <hex sha>`. Test it:
   `ssh -i visorfans-ci-deploy deploy@<IP> whoami` must print
   `deploy-gate: refused`.

3. **Pinned host key.** Get the fingerprint from the **DigitalOcean web
   console** (trusted channel): `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
   Then `ssh-keyscan -t ed25519 <IP> > known_hosts` and confirm
   `ssh-keygen -lf known_hosts` shows the same fingerprint.

4. **GitHub → Settings → Environments → `production`** (add required
   reviewers if you want a manual gate):
   - Secrets: `DEPLOY_SSH_KEY` (the private key file), `DEPLOY_HOST` (`<IP>`),
     `DEPLOY_KNOWN_HOSTS` (the verified line), optionally `SENTRY_AUTH_TOKEN`
     (source-map upload; scope: project releases).
   - Variables: `APP_URL=https://app.visorfans.com`,
     `API_URL=https://api.visorfans.com`,
     `NEXT_PUBLIC_MEDIA_ORIGIN=https://<ref>.supabase.co`,
     `NEXT_PUBLIC_SENTRY_DSN=<visorfans-web DSN>`, optionally `SENTRY_ORG`,
     `SENTRY_PROJECT_WEB=visorfans-web`.
   - Changing any `NEXT_PUBLIC_*` value needs a new image: re-run Deploy.
   - Delete the local private key file once it is in GitHub (keep it in
     Bitwarden if you want a copy).

5. **GHCR pull token on the droplet** (CI never sends it). GitHub → Settings →
   Developer settings → Personal access tokens (classic) → scope
   **`read:packages` only**, 1-year expiry (calendar reminder). As `deploy`:

   ```bash
   docker login ghcr.io -u <github-username> --password-stdin   # paste token, Ctrl-D
   ```

   It is stored in `/home/deploy/.docker/config.json` (mode 600).

---

## 5. First deploy + admin

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
   # prompts twice for the password (hidden); prints only the new user id
   ```

   Then log in at `POST /api/auth/login` and open `https://app.visorfans.com/admin`.
   **Approve nothing yet.**

---

## 6. NOWPayments: IPN + one live payment

1. NOWPayments dashboard → Store Settings → IPN: callback URL
   **`https://api.visorfans.com/api/payments/nowpayments/webhook`** (each
   payment also carries it as `ipn_callback_url`). The IPN secret there must
   equal `NOWPAYMENTS_IPN_SECRET`.
2. **Minimum amount.** Check the current USDT TRC-20 minimum in the
   dashboard, or `GET https://api.nowpayments.io/v1/min-amount?currency_from=usdttrc20&currency_to=usdttrc20`
   with your `x-api-key`. Pick the smallest pack priced at or above it
   (`starter` USD 3.99, `plus` 9.99, `pro` 29.99).
3. **Test subscriber + login** (no password on any command line):

   ```bash
   # on the droplet
   docker exec -it visorfans-api-1 node dist/scripts/ops/create-user.js \
     --role subscriber --email you+buyer@example.com --display-name "Test buyer"

   # on your machine — the JSON body comes from a 600 file, deleted after
   umask 077; printf '{"email":"you+buyer@example.com","password":"%s"}' "$(read -rs p; echo "$p")" > login.json
   curl -s -c jar.txt -H 'content-type: application/json' --data @login.json \
     https://api.visorfans.com/api/auth/login -o /dev/null -w '%{http_code}\n'   # 200
   rm login.json
   ```

4. **Checkout:**

   ```bash
   curl -s -b jar.txt -H 'content-type: application/json' \
     -d '{"packId":"plus","provider":"crypto"}' \
     https://api.visorfans.com/api/payments/checkout/credits
   ```

   The answer has `payment.payAddress`, `payment.payAmount`, `payment.payCurrency`.
   Send **exactly** `payAmount` USDT on **TRC-20** to `payAddress`.

5. **Confirm** (after the network confirmations):
   - `curl -s -b jar.txt https://api.visorfans.com/api/wallet/balance` → credits added once.
   - Supabase SQL editor:
     `select action, "entityId", "createdAt" from "AuditLog" where action like 'payment.%' or action like 'wallet.%' order by "createdAt" desc limit 10;`
     → `payment.charge_created`, then the confirmation and `wallet.credited`.
   - **Idempotency:** resend the IPN from the NOWPayments dashboard (or wait for
     a retry). The API answers `duplicate: true`; the balance does not change.
6. **Record what the live payment confirmed** (Open Item "Provider shapes need
   live verification"): `pay_address`, `pay_amount`, `pay_currency`,
   `payin_extra_id`, `order_id`, the `x-nowpayments-sig` HMAC-SHA512 scheme.
   Note any field that differed and send it back for an adapter fix.
7. `rm jar.txt`.

---

## 7. Re-enable the crons

1. GitHub → Settings → Secrets → Actions: `API_PUBLIC_URL=https://api.visorfans.com`
   and the cron secrets equal to the `api.env` values.
2. Actions → enable **Subscription renewals**, **Storage cleanup**,
   **Reconciliation**; run each once by hand (_Run workflow_) and check the
   step summary shows counts (no ids). They send no body and no Content-Type.
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

```bash
# a compose shortcut for the live release (put it in ~/.bashrc)
vf() { local t; t=$(cat /opt/visorfans/.current_tag); IMAGE_TAG=$t docker compose \
  --env-file /opt/visorfans/env/compose.env -f /opt/visorfans/releases/$t/compose.yaml "$@"; }

vf ps                 # health of every service
vf logs -f api        # API logs (also web, caddy)
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

This proves delivery (DSN, network, release tag); it bypasses the app's own
init, so it carries no request data by construction. The scrubber itself is
proven by the test suites — still apply the PII checklist above to the first
_real_ error event.
