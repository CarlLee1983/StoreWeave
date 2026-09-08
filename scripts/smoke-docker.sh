#!/usr/bin/env bash
# Build and exercise exactly one isolated release/Compose project.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RELEASE_ID="${STOREWEAVE_RELEASE:-commerce}"
case "$RELEASE_ID" in
  commerce) NAME=commerce; COMPOSE_FILE=compose.yaml; PORT="${COMMERCE_PORT:-3000}" ;;
  base) NAME=storeweave; COMPOSE_FILE=compose.base.yaml; PORT="${STOREWEAVE_PORT:-3000}" ;;
  *) echo 'Unknown release' >&2; exit 1 ;;
esac
PROJECT="${COMPOSE_PROJECT_NAME:-storeweave-smoke-$RELEASE_ID-$(date +%s)-$$}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]+$ ]] || { echo 'Invalid smoke project' >&2; exit 1; }
if [ -n "$(docker container ls -aq --filter "label=com.docker.compose.project=$PROJECT")" ]; then
  echo "Compose project already has containers: $PROJECT" >&2; exit 1
fi
for kind in network volume; do
  if [ -n "$(docker "$kind" ls -q --filter "label=com.docker.compose.project=$PROJECT")" ]; then
    echo "Compose project already has $kind resources: $PROJECT" >&2; exit 1
  fi
done
export STOREWEAVE_IMAGE="${STOREWEAVE_IMAGE:-storeweave/$RELEASE_ID:smoke-$PROJECT}"
export COMMERCE_ADMIN_TOKEN="${COMMERCE_ADMIN_TOKEN:-smoke-admin-token-0123456789}"
export COMMERCE_MCP_TOKEN="${COMMERCE_MCP_TOKEN:-smoke-mcp-token-0123456789}"
export DEMO_ERP_API_KEY="${DEMO_ERP_API_KEY:-smoke-erp-key}"
export STOREWEAVE_ADMIN_TOKEN="${STOREWEAVE_ADMIN_TOKEN:-smoke-base-admin-token-0123456789}"
KEEP="${KEEP:-false}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/storeweave-docker-smoke.XXXXXX")"
compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }
cleanup() {
  if [ "$KEEP" != true ]; then compose down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
if [ "$RELEASE_ID" = base ]; then
  cat > "$WORK/base.yaml" <<'CONFIG'
version: 1
store: { id: base-smoke, name: Base Smoke }
database: { url: '${STOREWEAVE_DATABASE_URL}' }
auth:
  tokens: [{ name: smoke, role: admin, secretRef: STOREWEAVE_ADMIN_TOKEN }]
extensions: []
CONFIG
  export STOREWEAVE_CONFIG_PATH="$WORK/base.yaml"
fi
compose up -d --build
for i in $(seq 1 90); do
  if curl --max-time 3 -fsS "http://localhost:$PORT/health/ready" >/dev/null 2>&1; then break; fi
  [ "$i" -lt 90 ] || { echo 'API did not become ready' >&2; compose logs --tail 60 api; exit 1; }
  sleep 2
done
compose exec -T api "$NAME" extension:list
# The same selected seed is shipped in the image and remains safe to repeat.
compose exec -T api /usr/local/bin/entrypoint.sh seed
compose exec -T api /usr/local/bin/entrypoint.sh seed
if [ "$RELEASE_ID" = commerce ]; then
  SMOKE_USER_EMAIL=smoke@example.com
  SMOKE_USER_PASSWORD=smoke-user-passphrase-2026
  compose exec -T -e COMMERCE_USER_PASSWORD="$SMOKE_USER_PASSWORD" api "$NAME" user:create \
    --email "$SMOKE_USER_EMAIL" --name 'Smoke operator' --role admin >/dev/null
  BASE_URL="http://localhost:$PORT" ADMIN_TOKEN="$COMMERCE_ADMIN_TOKEN" MCP_TOKEN="$COMMERCE_MCP_TOKEN" \
    SMOKE_USER_EMAIL="$SMOKE_USER_EMAIL" SMOKE_USER_PASSWORD="$SMOKE_USER_PASSWORD" bash scripts/smoke.sh
else
  BASE_URL="http://localhost:$PORT" ADMIN_TOKEN="$STOREWEAVE_ADMIN_TOKEN" bash scripts/smoke-base.sh
  compose exec -T api sh -c 'test ! -e /opt/storeweave/current/admin && test ! -e /opt/storeweave/current/theme-assets && test ! -e /etc/commerce && test ! -e /opt/commerce'
fi
printf 'Docker %s smoke passed (%s)\n' "$RELEASE_ID" "$PROJECT"
