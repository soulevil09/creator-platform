#!/usr/bin/env bash
# =============================================================================
# deploy.sh end-to-end test (Session 13, D7). Runs deploy.sh for real against a
# throwaway registry, database and root — inside a Linux docker host (it needs
# flock and a daemon that sees the same paths), e.g. the colima VM:
#
#   colima ssh -- bash infra/local/deploy-test.sh      # from the repo root
#
# Needs: creator-platform-{api,web}:local built, and infra/local/up.sh run once
# (for the generated env/certs). Ports 80/443 and 172.30.0.0/24 must be free
# (`infra/local/up.sh --down` first).
#
# Scenarios:
#   1. deploy GOOD            → success, .current_tag = GOOD, stack healthy
#   2. deploy GOOD again      → idempotent, still GOOD
#   3. deploy BROKEN (api exits at boot) → health fails → rolled back to GOOD
#   4. deploy NEXT with the database down → migration fails → aborted, GOOD
#                               still recorded and its containers untouched
#   5. invalid sha            → refused (exit 2)
# =============================================================================
set -uo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
gen="$repo/infra/local/.generated"
root="$HOME/.vf-deploy-test"
reg=localhost:5001
GOOD=aaaa111 BROKEN=bbbb222 NEXT=cccc333
failures=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }

cleanup() {
  VISORFANS_ROOT="$root" IMAGE_TAG="$GOOD" docker compose --env-file "$root/env/compose.env" \
    -f "$root/releases/$GOOD/compose.yaml" --profile migrate down -v >/dev/null 2>&1 || true
  docker rm -f vf-test-registry vf-test-pg >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT
cleanup

# ── Fixtures ─────────────────────────────────────────────────────────────────
docker run -d --name vf-test-registry -p 5001:5000 registry:2 >/dev/null
pg_password="$(openssl rand -hex 16)"
docker run -d --name vf-test-pg -p 55432:5432 -e POSTGRES_PASSWORD="$pg_password" \
  -e POSTGRES_DB=visorfans postgres:16.15-bookworm >/dev/null
sleep 3

for tag in $GOOD $NEXT; do
  docker tag creator-platform-api:local "$reg/test/creator-platform-api:$tag"
  docker tag creator-platform-web:local "$reg/test/creator-platform-web:$tag"
done
# BROKEN: same image, but the API exits at boot, so it never turns healthy.
printf 'FROM %s\nCMD ["node","-e","process.exit(1)"]\n' "creator-platform-api:local" \
  | docker build -q -t "$reg/test/creator-platform-api:$BROKEN" - >/dev/null
docker tag creator-platform-web:local "$reg/test/creator-platform-web:$BROKEN"
for tag in $GOOD $BROKEN $NEXT; do
  docker push -q "$reg/test/creator-platform-api:$tag" >/dev/null
  docker push -q "$reg/test/creator-platform-web:$tag" >/dev/null
done

mkdir -p "$root/env" "$root/certs" "$root/releases"
cp "$gen/certs/app.pem" "$gen/certs/app.key" "$root/certs/"
# The API reaches the published Postgres through the compose network gateway.
sed "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://postgres:$pg_password@172.30.0.1:55432/visorfans|" \
  "$gen/api.env" > "$root/env/api.env"
cat > "$root/env/compose.env" <<ENV
REGISTRY=$reg
GHCR_OWNER=test
API_HOST=api.visorfans.test
APP_HOST=app.visorfans.test
API_TLS=internal
ENV

deploy() { VISORFANS_ROOT="$root" bash "$repo/infra/deploy.sh" "$1" >"$root/last.log" 2>&1; }
current() { cat "$root/.current_tag" 2>/dev/null; }
api_container_image() {
  docker inspect visorfans-api-1 --format '{{.Config.Image}}' 2>/dev/null
}

# ── 1. first deploy ──────────────────────────────────────────────────────────
if deploy $GOOD && [[ "$(current)" == "$GOOD" ]]; then pass "1 deploy $GOOD"
else fail "1 deploy $GOOD"; cat "$root/last.log"; fi

# ── 2. idempotent re-deploy ──────────────────────────────────────────────────
if deploy $GOOD && [[ "$(current)" == "$GOOD" ]]; then pass "2 re-deploy $GOOD is a no-op"
else fail "2 re-deploy"; tail -20 "$root/last.log"; fi

# ── 3. broken release rolls back ─────────────────────────────────────────────
if deploy $BROKEN; then fail "3 broken release reported success"
elif [[ "$(current)" == "$GOOD" ]] && [[ "$(api_container_image)" == *":$GOOD" ]] \
  && grep -q "rolled back to $GOOD" "$root/last.log"; then
  pass "3 broken release → rolled back to $GOOD"
else fail "3 rollback"; tail -20 "$root/last.log"; fi

# ── 4. failed migration aborts before touching anything ──────────────────────
docker stop vf-test-pg >/dev/null
if deploy $NEXT; then fail "4 deploy with the database down reported success"
elif [[ "$(current)" == "$GOOD" ]] && [[ "$(api_container_image)" == *":$GOOD" ]] \
  && grep -q "migration FAILED" "$root/last.log"; then
  pass "4 failed migration → aborted, $GOOD untouched"
else fail "4 migrate gate"; tail -20 "$root/last.log"; fi
docker start vf-test-pg >/dev/null

# ── 5. sha validation ────────────────────────────────────────────────────────
VISORFANS_ROOT="$root" bash "$repo/infra/deploy.sh" 'abc;id' >/dev/null 2>&1
[[ $? -eq 2 ]] && pass "5 invalid sha refused" || fail "5 invalid sha accepted"

echo
[[ $failures -eq 0 ]] && echo "deploy-test: all scenarios passed" || echo "deploy-test: $failures FAILED"
exit $((failures > 0))
