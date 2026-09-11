#!/usr/bin/env bash
# Install the selected tarball on an isolated Debian container without host Node.js.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RELEASE_ID="${STOREWEAVE_RELEASE:-commerce}"
case "$RELEASE_ID" in commerce) NAME=commerce; DB_USER=commerce; DB_NAME=commerce ;; base) NAME=storeweave; DB_USER=commerce; DB_NAME=commerce ;; *) echo 'Unknown release' >&2; exit 1 ;; esac
VERSION="${STOREWEAVE_RELEASE_VERSION:-${COMMERCE_RELEASE_VERSION:-$(node -p "require('./package.json').version")}}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/storeweave-native-smoke.XXXXXX")"
export STOREWEAVE_BUILD_DIR="${STOREWEAVE_BUILD_DIR:-$WORK/build}"
export STOREWEAVE_RELEASE_DIR="${STOREWEAVE_RELEASE_DIR:-$WORK/release}"
PROJECT="${SMOKE_PROJECT:-storeweave-native-$RELEASE_ID-$(date +%s)-$$}"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]+$ ]] || { echo 'Invalid smoke project' >&2; exit 1; }
PORT="${SMOKE_PORT:-3210}"
SMOKE_HOST="${SMOKE_HOST:-localhost}"
SMOKE_BIND_HOST="${SMOKE_BIND_HOST:-127.0.0.1}"
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
if [ "${STOREWEAVE_SKIP_BUILD:-false}" = true ]; then
  echo "==> reusing release artifact"
else
  STOREWEAVE_TARGET_ARCH=x64 bash scripts/build-release.sh
fi
TARBALL="$STOREWEAVE_RELEASE_DIR/$NAME-$VERSION.tar.gz"
[ -f "$TARBALL" ] || { echo "Missing release artifact: $TARBALL" >&2; exit 1; }
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
docker run -d --init --name "$APP" --network "$NET" --platform linux/amd64 -p "$SMOKE_BIND_HOST:$PORT:3000" \
  debian:bookworm-slim sleep infinity >/dev/null
CREATED_APP=true
docker exec "$APP" sh -c 'export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gpg >/dev/null
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.org.gpg
  echo "deb [signed-by=/usr/share/keyrings/postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq && apt-get install -y -qq postgresql-client-17 >/dev/null'
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
  if curl --max-time 2 -fsS "http://$SMOKE_HOST:$PORT/health/ready" >/dev/null 2>&1; then break; fi
  [ "$i" -lt 60 ] || { echo 'API did not start' >&2; exit 1; }
  sleep 1
done
# Token 不再寫在設定檔：由 CLI 現場簽發，秘密只在標準輸出出現一次（ADR 0043）。
secret_of() { sed -n 's/.*"secret":"\([^"]*\)".*/\1/p'; }
full_recovery_smoke() {
  # The copied bundle survives the deliberately replaced database container and
  # missing local-storage directory below, so this checks a real cold recovery.
  local object_payload object_id object_sha job_id occurrence_id scheduled_for job_payload expected_job actual_job storage_key actual_sha
  object_payload="$WORK/recovery-media.txt"
  printf 'B15 complete recovery smoke %s\n' "$PROJECT" > "$object_payload"
  curl -fsS -o "$WORK/recovery-media.json" -X POST "http://$SMOKE_HOST:$PORT/api/v1/storage/objects" \
    -H "authorization: Bearer $ADMIN_TOKEN" -F "file=@$object_payload;type=text/plain"
  object_id="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.data.id)' "$WORK/recovery-media.json")"
  object_sha="$(node -e 'const j=require(process.argv[1]); process.stdout.write(j.data.sha256)' "$WORK/recovery-media.json")"
  [ -n "$object_id" ] && [ -n "$object_sha" ] || { echo 'Recovery upload did not return an object identity' >&2; return 1; }

  job_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  occurrence_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  scheduled_for="$(node -e 'process.stdout.write(new Date(Date.now() + 60 * 60 * 1000).toISOString())')"
  job_payload="$(RECOVERY_SCHEDULED_FOR="$scheduled_for" node -e 'process.stdout.write(JSON.stringify({bucket:1,scheduledFor:process.env.RECOVERY_SCHEDULED_FOR}))')"
  printf '%s\n' "INSERT INTO public.platform_jobs (id, occurrence_id, type, payload, payload_version, dedupe_key, status, max_attempts, run_at) VALUES (:'job_id'::uuid, :'occurrence_id'::uuid, 'platform.media.cleanup-orphans', :'payload'::jsonb, 1, 'b15-smoke-recovery', 'pending', 5, now() + interval '1 hour');" \
    | docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
      -v job_id="$job_id" -v occurrence_id="$occurrence_id" -v payload="$job_payload" >/dev/null

  docker exec --user "$NAME" "$APP" "$NAME" stop
  docker exec --user "$NAME" "$APP" "$NAME" backup --include-media --external-writers-stopped --out "/var/lib/$NAME/backups/b15.bundle"
  docker cp "$APP:/var/lib/$NAME/backups/b15.bundle" "$WORK/full.bundle"
  [ -f "$WORK/full.bundle/manifest.json" ] || { echo 'Full backup did not produce a bundle manifest' >&2; return 1; }

  # Replace both persistent sides before recovery. The old storage tree is
  # renamed rather than deleted because this is a test-only container.
  docker rm -f "$PG" >/dev/null
  docker run -d --name "$PG" --network "$NET" --platform linux/amd64 \
    -e POSTGRES_USER=commerce -e POSTGRES_PASSWORD=smokepw -e POSTGRES_DB=commerce postgres:17-alpine >/dev/null
  for i in $(seq 1 60); do
    if docker exec "$PG" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
    [ "$i" -lt 60 ] || { echo 'Fresh Postgres did not start' >&2; return 1; }
    sleep 1
  done
  docker exec --user "$NAME" "$APP" sh -c "test ! -d /var/lib/$NAME/storage || mv /var/lib/$NAME/storage /var/lib/$NAME/storage-lost"
  docker cp "$WORK/full.bundle" "$APP:/tmp/b15.bundle"
  docker exec "$APP" sh -c "chown -R $NAME:$NAME /tmp/b15.bundle"
  docker exec --user "$NAME" "$APP" "$NAME" restore --bundle /tmp/b15.bundle --maintenance-database postgres --yes --external-writers-stopped
  docker exec --user "$NAME" "$APP" "$NAME" start
  for i in $(seq 1 60); do
    if curl --max-time 2 -fsS "http://$SMOKE_HOST:$PORT/health/ready" >/dev/null 2>&1; then break; fi
    [ "$i" -lt 60 ] || { echo 'Recovered API did not become ready' >&2; return 1; }
    sleep 1
  done
  storage_key="$(docker exec "$PG" psql -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT storage_key FROM public.platform_storage_objects WHERE id = '$object_id'::uuid")"
  actual_sha="$(docker exec --user "$NAME" "$APP" sh -c "sha256sum '/var/lib/$NAME/storage/objects/$storage_key' | cut -d ' ' -f1")"
  expected_job="$job_id|$occurrence_id|platform.media.cleanup-orphans|pending|1|b15-smoke-recovery|1|$scheduled_for"
  actual_job="$(docker exec "$PG" psql -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT concat_ws('|', id::text, occurrence_id::text, type, status, payload_version::text, coalesce(dedupe_key, ''), payload->>'bucket', payload->>'scheduledFor') FROM public.platform_jobs WHERE id = '$job_id'::uuid")"
  [ "$actual_sha" = "$object_sha" ] || { echo "Recovered media SHA mismatch: expected $object_sha, got $actual_sha" >&2; return 1; }
  [ "$actual_job" = "$expected_job" ] || { echo "Recovered job mismatch: expected $expected_job, got $actual_job" >&2; return 1; }
  printf 'Full native recovery passed (media SHA and pending job restored)\n'
}
docker exec --user "$NAME" "$APP" "$NAME" extension:list
if [ "$RELEASE_ID" = commerce ]; then
  SMOKE_USER_EMAIL=smoke@example.com
  SMOKE_USER_PASSWORD=smoke-user-passphrase-2026
  docker exec --user "$NAME" -e COMMERCE_USER_PASSWORD="$SMOKE_USER_PASSWORD" "$APP" "$NAME" user:create \
    --email "$SMOKE_USER_EMAIL" --name 'Smoke operator' --role admin >/dev/null
  ADMIN_TOKEN="$(docker exec --user "$NAME" "$APP" "$NAME" token:create --name smoke-admin --role admin --json | secret_of)"
  MCP_TOKEN="$(docker exec --user "$NAME" "$APP" "$NAME" token:create --name smoke-mcp --role mcp --json | secret_of)"
  [ -n "$ADMIN_TOKEN" ] || { echo 'token:create did not return a secret' >&2; exit 1; }
  BASE_URL="http://$SMOKE_HOST:$PORT" ADMIN_TOKEN="$ADMIN_TOKEN" MCP_TOKEN="$MCP_TOKEN" \
    SMOKE_USER_EMAIL="$SMOKE_USER_EMAIL" SMOKE_USER_PASSWORD="$SMOKE_USER_PASSWORD" bash scripts/smoke.sh
  full_recovery_smoke
else
  ADMIN_TOKEN="$(docker exec --user "$NAME" "$APP" "$NAME" token:create --name smoke-admin --role admin --json | secret_of)"
  [ -n "$ADMIN_TOKEN" ] || { echo 'token:create did not return a secret' >&2; exit 1; }
  BASE_URL="http://$SMOKE_HOST:$PORT" ADMIN_TOKEN="$ADMIN_TOKEN" bash scripts/smoke-base.sh
  full_recovery_smoke
fi
docker exec --user "$NAME" "$APP" "$NAME" stop
printf 'Native %s smoke passed; artifacts: %s\n' "$RELEASE_ID" "$STOREWEAVE_RELEASE_DIR"
