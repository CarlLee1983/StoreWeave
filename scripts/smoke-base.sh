#!/usr/bin/env bash
# Base-only HTTP smoke: prove platform endpoints work and Commerce routes are absent.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
ADMIN_TOKEN="${ADMIN_TOKEN:?ADMIN_TOKEN is required}"

status() {
  local path="$1"
  shift
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 3 --max-time 10 "$@" "$BASE_URL$path"
}

expect() {
  local label="$1" expected="$2" path="$3"
  shift 3
  local actual
  if ! actual="$(status "$path" "$@")"; then
    printf 'FAIL %s: curl failed\n' "$label" >&2
    exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'ok %s\n' "$label"
}

expect 'health live' 200 /health/live
expect 'health ready' 200 /health/ready
expect 'health dependencies unauthenticated' 401 /health/dependencies
expect 'health dependencies authenticated' 200 /health/dependencies -H "authorization: Bearer $ADMIN_TOKEN"
expect 'Base jobs endpoint' 200 /api/v1/system/jobs/dead -H "authorization: Bearer $ADMIN_TOKEN"
expect 'Base quarantined jobs endpoint' 200 /api/v1/system/jobs/quarantined -H "authorization: Bearer $ADMIN_TOKEN"
expect 'Base outbox failures endpoint' 200 /api/v1/system/outbox/failures -H "authorization: Bearer $ADMIN_TOKEN"

# base 也是一個網站：首頁渲染得出來，導覽來自 release 預設值（ADR 0046）。
expect 'Base storefront home' 200 /

for path in /api/v1/products /admin /storefront-assets/woven-day-hero.png /mcp; do
  expect "Commerce path absent: $path" 404 "$path"
done
