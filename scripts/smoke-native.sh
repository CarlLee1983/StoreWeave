#!/usr/bin/env bash
# Native Release smoke test：
# 在一個乾淨的 Debian 容器（沒有預先安裝 Node.js）裡安裝 tarball 並跑完三條垂直流程。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
RELEASE_ROOT="release"
TARBALL="$RELEASE_ROOT/commerce-$VERSION.tar.gz"
NET=commerce-native-smoke
PG=commerce-native-pg
APP=commerce-native-app

# 只要有任何一個被 git 追蹤的來源檔比 tarball 新，這份 tarball 就過期了。
# 重用一份過期的產物會讓 smoke test 測到不存在的舊行為，看起來像程式碼壞掉。
stale_source() {
  [ -f "$TARBALL" ] || return 0
  local file
  while IFS= read -r -d '' file; do
    if [ "$file" -nt "$TARBALL" ]; then
      return 0
    fi
  done < <(git ls-files -z -- apps packages tools scripts deployments \
             package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json)
  return 1
}

if stale_source; then
  echo "==> building native release"
  rm -rf "$RELEASE_ROOT"
  COMMERCE_TARGET_ARCH=x64 bash scripts/build-release.sh
else
  echo "==> reusing ${TARBALL}（沒有比它更新的來源檔）"
fi

cleanup() {
  docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=commerce -e POSTGRES_PASSWORD=smokepw -e POSTGRES_DB=commerce \
  --platform linux/amd64 postgres:17-alpine >/dev/null

echo "==> waiting for postgres"
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U commerce -d commerce >/dev/null 2>&1 && break
  sleep 1
done

echo "==> starting clean debian host (no Node.js installed)"
docker run -d --name "$APP" --network "$NET" --platform linux/amd64 -p 3210:3000 \
  debian:bookworm-slim sleep infinity >/dev/null

# 容器內用 pid file 模式，無須安裝（也不能啟動）systemd。
docker exec "$APP" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl postgresql-client >/dev/null'
echo "==> confirming the host really has no node"
docker exec "$APP" sh -c 'command -v node && { echo "node should not be preinstalled"; exit 1; } || echo "    ok: no node on PATH"'

docker cp "$TARBALL" "$APP:/tmp/release.tar.gz"
docker exec "$APP" sh -c 'mkdir -p /tmp/rel && tar -xzf /tmp/release.tar.gz -C /tmp/rel --strip-components=1'
docker exec "$APP" sh -c 'cd /tmp/rel && ./scripts/install.sh'

docker exec "$APP" sh -c "cat > /etc/commerce/commerce.env <<'ENV'
DATABASE_URL=postgres://commerce:smokepw@$PG:5432/commerce
COMMERCE_PUBLIC_URL=http://localhost:3000
COMMERCE_ADMIN_TOKEN=native-admin-token-0123456789
COMMERCE_MCP_TOKEN=native-mcp-token-0123456789
DEMO_ERP_API_KEY=native-erp-key
ENV
chmod 0600 /etc/commerce/commerce.env"

echo "==> commerce install"
docker exec "$APP" sh -c 'set -a; . /etc/commerce/commerce.env; set +a; commerce install'

echo "==> commerce start（容器內沒有 systemd，CLI 會退回 pid file 模式）"
docker exec -d "$APP" sh -c 'set -a; . /etc/commerce/commerce.env; set +a; commerce start'
sleep 8

echo "==> commerce status / doctor"
docker exec "$APP" sh -c 'set -a; . /etc/commerce/commerce.env; set +a; commerce status; commerce doctor' || true

echo "==> smoke test（從主機打進容器）"
BASE_URL="http://localhost:3210" \
ADMIN_TOKEN="native-admin-token-0123456789" \
MCP_TOKEN="native-mcp-token-0123456789" \
  bash scripts/smoke.sh

echo "==> native release smoke test 通過"
