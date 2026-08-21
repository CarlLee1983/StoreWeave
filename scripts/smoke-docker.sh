#!/usr/bin/env bash
# Docker Compose smoke test：建置映像、啟動完整環境、跑完三條垂直流程、再收乾淨。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export COMMERCE_ADMIN_TOKEN="${COMMERCE_ADMIN_TOKEN:-smoke-admin-token-0123456789}"
export COMMERCE_MCP_TOKEN="${COMMERCE_MCP_TOKEN:-smoke-mcp-token-0123456789}"
export DEMO_ERP_API_KEY="${DEMO_ERP_API_KEY:-smoke-erp-key}"
export COMMERCE_PORT="${COMMERCE_PORT:-3000}"
KEEP="${KEEP:-false}"

cleanup() {
  if [ "$KEEP" != "true" ]; then
    echo "==> tearing down"
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> docker compose up -d --build"
docker compose up -d --build

echo "==> waiting for /health/ready"
for i in $(seq 1 90); do
  if curl -fsS "http://localhost:$COMMERCE_PORT/health/ready" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 90 ] && { echo "api did not become ready"; docker compose logs --tail 60 api; exit 1; }
  sleep 2
done

echo "==> commerce doctor（在容器內執行）"
docker compose exec -T api commerce doctor || true

echo "==> commerce extension:list"
docker compose exec -T api commerce extension:list

echo "==> smoke test"
BASE_URL="http://localhost:$COMMERCE_PORT" \
ADMIN_TOKEN="$COMMERCE_ADMIN_TOKEN" \
MCP_TOKEN="$COMMERCE_MCP_TOKEN" \
  bash scripts/smoke.sh

echo "==> docker compose smoke test 通過"
