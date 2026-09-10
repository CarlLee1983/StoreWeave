#!/usr/bin/env bash
# Install the selected tarball on an isolated Debian container without host Node.js.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RELEASE_ID="${STOREWEAVE_RELEASE:-commerce}"
case "$RELEASE_ID" in commerce) NAME=commerce ;; base) NAME=storeweave ;; *) echo 'Unknown release' >&2; exit 1 ;; esac
VERSION="${STOREWEAVE_RELEASE_VERSION:-${COMMERCE_RELEASE_VERSION:-$(node -p "require('./package.json').version")}}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/storeweave-native-smoke.XXXXXX")"
export STOREWEAVE_BUILD_DIR="${STOREWEAVE_BUILD_DIR:-$WORK/build}"
export STOREWEAVE_RELEASE_DIR="${STOREWEAVE_RELEASE_DIR:-$WORK/release}"
PROJECT="${SMOKE_PROJECT:-storeweave-native-$RELEASE_ID-$(date +%s)-$$}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]+$ ]] || { echo 'Invalid smoke project' >&2; exit 1; }
PORT="${SMOKE_PORT:-3210}"
NET="$PROJECT-net"
PG="$PROJECT-pg"
APP="$PROJECT-app"
for container in "$PG" "$APP"; do
  if docker container inspect "$container" >/dev/null 2>&1; then echo "Container already exists: $container" >&2; exit 1; fi
done
if docker network inspect "$NET" >/dev/null 2>&1; then echo "Network already exists: $NET" >&2; exit 1; fi
# Only objects successfully created by this invocation may be removed.
CREATED_NET=false CREATED_PG=false CREATED_APP=false
cleanup() {
  if [ "$CREATED_APP" = true ]; then docker rm -f "$APP" >/dev/null 2>&1 || true; fi
  if [ "$CREATED_PG" = true ]; then docker rm -f "$PG" >/dev/null 2>&1 || true; fi
  if [ "$CREATED_NET" = true ]; then docker network rm "$NET" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
STOREWEAVE_TARGET_ARCH=x64 bash scripts/build-release.sh
TARBALL="$STOREWEAVE_RELEASE_DIR/$NAME-$VERSION.tar.gz"
docker network create "$NET" >/dev/null
CREATED_NET=true
docker run -d --name "$PG" --network "$NET" --platform linux/amd64 \
  -e POSTGRES_USER=commerce -e POSTGRES_PASSWORD=smokepw -e POSTGRES_DB=commerce postgres:17-alpine >/dev/null
CREATED_PG=true
for i in $(seq 1 60); do
  if docker exec "$PG" pg_isready -U commerce -d commerce >/dev/null 2>&1; then break; fi
  [ "$i" -lt 60 ] || { echo 'Postgres did not start' >&2; exit 1; }
  sleep 1
done
# Reap the detached PID-mode services as a native host's init would.
docker run -d --init --name "$APP" --network "$NET" --platform linux/amd64 -p "127.0.0.1:$PORT:3000" \
  debian:bookworm-slim sleep infinity >/dev/null
CREATED_APP=true
docker exec "$APP" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl postgresql-client >/dev/null'
docker exec "$APP" sh -c 'if command -v node >/dev/null; then echo "Unexpected host Node.js" >&2; exit 1; fi'
docker cp "$TARBALL" "$APP:/tmp/release.tar.gz"
docker exec "$APP" sh -c 'mkdir /tmp/rel && tar -xzf /tmp/release.tar.gz -C /tmp/rel --strip-components=1 && cp /tmp/rel/release-manifest.json /tmp/manifest.original'
docker exec "$APP" /tmp/rel/runtime/bin/node -e '
  const fs = require("node:fs"), path = "/tmp/rel/release-manifest.json";
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.releaseVersion = "tampered";
  fs.writeFileSync(path, JSON.stringify(manifest));
'
if docker exec "$APP" /tmp/rel/scripts/install.sh > "$WORK/tampered.log" 2>&1; then
  echo 'Installer unexpectedly accepted a changed manifest' >&2; exit 1
fi
grep -q 'Release manifest or build metadata mismatch' "$WORK/tampered.log"
docker exec "$APP" sh -c 'mv /tmp/manifest.original /tmp/rel/release-manifest.json && /tmp/rel/scripts/install.sh'
# Reinstalling the same version must preserve the installed version and current link.
if docker exec "$APP" /tmp/rel/scripts/install.sh > "$WORK/reinstall.log" 2>&1; then
  echo 'Installer unexpectedly replaced the existing release' >&2; exit 1
fi
grep -q 'Release already installed' "$WORK/reinstall.log"
cat > "$WORK/secret.env" <<ENV
DATABASE_URL=postgres://commerce:smokepw@$PG:5432/commerce
STOREWEAVE_DATABASE_URL=postgres://commerce:smokepw@$PG:5432/commerce
COMMERCE_PUBLIC_URL=http://localhost:3000
DEMO_ERP_API_KEY=native-erp-key
COMMERCE_SIGNING_KEY_K1=bmF0aXZlLXNpZ25pbmcta2V5LTMyLWJ5dGVzLTAwMDE
STOREWEAVE_SIGNING_KEY_K1=bmF0aXZlLXNpZ25pbmcta2V5LTMyLWJ5dGVzLTAwMDE
ENV
docker cp "$WORK/secret.env" "$APP:/etc/$NAME/$NAME.env"
docker exec "$APP" sh -c "chown root:$NAME /etc/$NAME/$NAME.env && chmod 0640 /etc/$NAME/$NAME.env"
if [ "$RELEASE_ID" = base ]; then
  cat > "$WORK/base.yaml" <<'CONFIG'
version: 1
store: { id: base-smoke, name: Base Smoke }
database: { url: '${STOREWEAVE_DATABASE_URL}' }
security:
  signingKeys: [{ id: k1, secretRef: STOREWEAVE_SIGNING_KEY_K1 }]
extensions: []
secrets: { provider: file, file: /etc/storeweave/storeweave.env }
CONFIG
  docker cp "$WORK/base.yaml" "$APP:/etc/$NAME/$NAME.yaml"
fi
# The release account must be able to read its file-backed secrets without root.
docker exec --user "$NAME" "$APP" "$NAME" install
docker exec --user "$NAME" "$APP" "$NAME" start
for i in $(seq 1 60); do
  if curl --max-time 2 -fsS "http://localhost:$PORT/health/ready" >/dev/null 2>&1; then break; fi
  [ "$i" -lt 60 ] || { echo 'API did not start' >&2; exit 1; }
  sleep 1
done
# Token 不再寫在設定檔：由 CLI 現場簽發，秘密只在標準輸出出現一次（ADR 0043）。
secret_of() { sed -n 's/.*"secret":"\([^"]*\)".*/\1/p'; }
docker exec --user "$NAME" "$APP" "$NAME" extension:list
if [ "$RELEASE_ID" = commerce ]; then
  SMOKE_USER_EMAIL=smoke@example.com
  SMOKE_USER_PASSWORD=smoke-user-passphrase-2026
  docker exec --user "$NAME" -e COMMERCE_USER_PASSWORD="$SMOKE_USER_PASSWORD" "$APP" "$NAME" user:create \
    --email "$SMOKE_USER_EMAIL" --name 'Smoke operator' --role admin >/dev/null
  ADMIN_TOKEN="$(docker exec --user "$NAME" "$APP" "$NAME" token:create --name smoke-admin --role admin --json | secret_of)"
  MCP_TOKEN="$(docker exec --user "$NAME" "$APP" "$NAME" token:create --name smoke-mcp --role mcp --json | secret_of)"
  [ -n "$ADMIN_TOKEN" ] || { echo 'token:create did not return a secret' >&2; exit 1; }
  BASE_URL="http://localhost:$PORT" ADMIN_TOKEN="$ADMIN_TOKEN" MCP_TOKEN="$MCP_TOKEN" \
    SMOKE_USER_EMAIL="$SMOKE_USER_EMAIL" SMOKE_USER_PASSWORD="$SMOKE_USER_PASSWORD" bash scripts/smoke.sh
else
  ADMIN_TOKEN="$(docker exec --user "$NAME" "$APP" "$NAME" token:create --name smoke-admin --role admin --json | secret_of)"
  [ -n "$ADMIN_TOKEN" ] || { echo 'token:create did not return a secret' >&2; exit 1; }
  BASE_URL="http://localhost:$PORT" ADMIN_TOKEN="$ADMIN_TOKEN" bash scripts/smoke-base.sh
fi
docker exec --user "$NAME" "$APP" "$NAME" stop
printf 'Native %s smoke passed; artifacts: %s\n' "$RELEASE_ID" "$STOREWEAVE_RELEASE_DIR"
