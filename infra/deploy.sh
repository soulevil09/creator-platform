#!/usr/bin/env bash
# =============================================================================
# Deploy one release (Session 13, D7). Installed at /opt/visorfans/bin/deploy.sh
# (root-owned), run as `deploy` — by CI through deploy-gate, or by hand:
#
#   /opt/visorfans/bin/deploy.sh <sha>        # deploy, or roll back to <sha>
#
#   1. validate <sha>; take the deploy lock
#   2. pull both images for <sha>
#   3. extract that release's compose.yaml + Caddyfile (shipped in the API
#      image) into /opt/visorfans/releases/<sha>/
#   4. run migrations (`migrate` profile) — on failure ABORT: nothing running
#      has changed
#   5. `up -d` the release and wait for api + web to be healthy and the API to
#      be ready (DB reachable)
#   6. success → record <sha> in /opt/visorfans/.current_tag
#      failure → bring the previous tag back up, exit non-zero
#
# Idempotent: re-deploying the current sha re-pulls, re-migrates (a no-op) and
# leaves the same containers. Migrations are forward-only, so a rollback runs
# the previous code against the newer schema — migrations must stay
# backward-compatible for one release (expand, then contract).
#
# Downtime: compose recreates api and web in turn (no blue/green on one
# droplet) — typically 10–20 s, within the ≤ 30 s target.
# =============================================================================
set -euo pipefail

# Overridable only by a local operator (deploy.sh's own test harness): the SSH
# path cannot set it — `restrict` forbids environment passing, and
# deploy-gate execs this script with a fixed command line.
ROOT="${VISORFANS_ROOT:-/opt/visorfans}"
export VISORFANS_ROOT="$ROOT"
LOG="$ROOT/deploy.log"
COMPOSE_ENV="$ROOT/env/compose.env"
CURRENT_FILE="$ROOT/.current_tag"
HEALTH_TIMEOUT=120

exec > >(tee -a "$LOG") 2>&1
log() { printf '%s [deploy] %s\n' "$(date -u +%FT%TZ)" "$*"; }

sha="${1:-}"
if ! [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]]; then
  log "refused: '<sha>' must match ^[0-9a-f]{7,40}\$"
  exit 2
fi

exec 9>"$ROOT/.deploy.lock"
if ! flock -n 9; then
  log "another deploy is running"
  exit 75
fi

set -a
# shellcheck source=/dev/null
source "$COMPOSE_ENV"
set +a
registry="${REGISTRY:-ghcr.io}"
owner="${GHCR_OWNER:-soulevil09}"
api_image="$registry/$owner/creator-platform-api:$sha"
web_image="$registry/$owner/creator-platform-web:$sha"
previous="$(cat "$CURRENT_FILE" 2>/dev/null || true)"

compose() {
  local tag="$1"; shift
  IMAGE_TAG="$tag" docker compose --env-file "$COMPOSE_ENV" \
    -f "$ROOT/releases/$tag/compose.yaml" "$@"
}

release_files() {
  local tag="$1" dir="$ROOT/releases/$1" cid
  [[ -f "$dir/compose.yaml" ]] && return 0
  mkdir -p "$dir"
  cid="$(docker create "$registry/$owner/creator-platform-api:$tag")"
  docker cp "$cid:/app/infra/." "$dir/"
  docker rm "$cid" >/dev/null
}

healthy() {
  local tag="$1"
  compose "$tag" up -d --wait --wait-timeout "$HEALTH_TIMEOUT" || return 1
  # Liveness passed; readiness proves the database is reachable too.
  compose "$tag" exec -T api node -e \
    "fetch('http://127.0.0.1:4000/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
}

log "deploying $sha (previous: ${previous:-none})"
docker pull --quiet "$api_image"
docker pull --quiet "$web_image"
release_files "$sha"

log "migrating"
if ! compose "$sha" --profile migrate run --rm migrate; then
  log "migration FAILED — deploy aborted, $previous is still serving"
  exit 1
fi

log "starting $sha"
if healthy "$sha"; then
  echo "$sha" > "$CURRENT_FILE"
  log "deployed $sha"
  # Keep the last 5 release directories and any image still referenced.
  ls -1t "$ROOT/releases" | tail -n +6 | xargs -r -I{} rm -rf "$ROOT/releases/{}"
  docker image prune -f >/dev/null
  exit 0
fi

log "health check FAILED for $sha"
if [[ -n "$previous" && "$previous" != "$sha" ]]; then
  log "rolling back to $previous"
  release_files "$previous"
  if healthy "$previous"; then
    log "rolled back to $previous"
  else
    log "ROLLBACK FAILED — manual intervention required (docs/deployment/runbook.md §8)"
  fi
fi
exit 1
