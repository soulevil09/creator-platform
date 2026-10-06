#!/usr/bin/env bash
# =============================================================================
# Bring up the production compose stack locally (Session 13, D7/D9).
#
#   infra/local/up.sh            # images must exist: creator-platform-{api,web}:local
#   infra/local/up.sh --build    # build both images first (from the repo root)
#   infra/local/up.sh --down     # tear down (volumes included)
#
# Generates throwaway secrets + certificates into infra/local/.generated/
# (gitignored) on first run. NODE_ENV=production inside, so every production
# boot rule (mock ban, https same-site URLs, TRUST_PROXY CIDR, cron secrets)
# applies exactly as on the droplet.
# =============================================================================
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
gen="$here/.generated"
compose=(docker compose -p visorfans-local --env-file "$gen/compose.env"
  -f "$repo/infra/compose.yaml" -f "$here/compose.local.yaml")

if [[ "${1:-}" == "--down" ]]; then
  "${compose[@]}" --profile migrate down -v
  exit 0
fi

if [[ "${1:-}" == "--build" ]]; then
  sha="$(git -C "$repo" rev-parse HEAD)"
  docker build -f "$repo/apps/api/Dockerfile" -t creator-platform-api:local \
    --build-arg GIT_SHA="$sha" "$repo"
  docker build -f "$repo/apps/web/Dockerfile" -t creator-platform-web:local \
    --build-arg GIT_SHA="$sha" \
    --build-arg NEXT_PUBLIC_APP_URL=https://app.visorfans.test \
    --build-arg NEXT_PUBLIC_API_URL=https://api.visorfans.test "$repo"
fi

rand() { openssl rand -hex 32; }

if [[ ! -f "$gen/api.env" ]]; then
  mkdir -p "$gen/certs"
  pg_password="$(rand)"
  umask 077
  cat > "$gen/postgres.env" <<ENV
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$pg_password
POSTGRES_DB=visorfans
ENV
  cat > "$gen/compose.env" <<ENV
IMAGE_TAG=local
API_HOST=api.visorfans.test
APP_HOST=app.visorfans.test
API_TLS=internal
ENV
  # The production variable set (docs/deployment/runbook.md §3), local values.
  cat > "$gen/api.env" <<ENV
NODE_ENV=production
DATABASE_URL=postgresql://postgres:$pg_password@postgres:5432/visorfans
JWT_SECRET=$(rand)
JWT_REFRESH_SECRET=$(rand)
WATERMARK_TRACE_SECRET=$(rand)
APP_URL=https://app.visorfans.test
API_PUBLIC_URL=https://api.visorfans.test
TRUST_PROXY=172.30.0.0/24
SUBSCRIPTION_RENEWAL_CRON_SECRET=$(rand)
STORAGE_CLEANUP_CRON_SECRET=$(rand)
RECONCILIATION_CRON_SECRET=$(rand)
PAYMENT_PROVIDER_PIX=disabled
PAYMENT_PROVIDER_CRYPTO=nowpayments
NOWPAYMENTS_API_KEY=local-not-a-real-key
NOWPAYMENTS_IPN_SECRET=$(rand)
NOWPAYMENTS_API_URL=https://nowpayments.invalid
PAYMENT_PROVIDER_CARD=disabled
PAYOUT_PROVIDER=disabled
AI_PROVIDER=disabled
EMAIL_PROVIDER=disabled
STORAGE_ENDPOINT=https://storage.invalid/storage/v1/s3
STORAGE_BUCKET=local
STORAGE_ACCESS_KEY=local
STORAGE_SECRET_KEY=$(rand)
ENV
  # Self-signed stand-in for the Cloudflare Origin CA certificate.
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=app.visorfans.test" \
    -addext "subjectAltName=DNS:app.visorfans.test" \
    -keyout "$gen/certs/app.key" -out "$gen/certs/app.pem" 2>/dev/null
  chmod 644 "$gen/certs/app.pem" "$gen/certs/app.key" # read by the caddy user in the container
fi

"${compose[@]}" --profile migrate run --rm migrate
"${compose[@]}" up -d --wait --wait-timeout 120
"${compose[@]}" ps
