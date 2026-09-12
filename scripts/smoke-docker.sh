#!/usr/bin/env bash
# Build and exercise exactly one isolated release/Compose project.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export STOREWEAVE_SOURCE_REVISION="${STOREWEAVE_SOURCE_REVISION:-$(git rev-parse HEAD)}"
RELEASE_ID="${STOREWEAVE_RELEASE:-commerce}"
case "$RELEASE_ID" in
  commerce) NAME=commerce; DB_USER=commerce; DB_NAME=commerce; COMPOSE_FILE=compose.yaml; PORT="${COMMERCE_PORT:-3000}" ;;
  base) NAME=storeweave; DB_USER=storeweave; DB_NAME=storeweave; COMPOSE_FILE=compose.base.yaml; PORT="${STOREWEAVE_PORT:-3000}" ;;
  *) echo 'Unknown release' >&2; exit 1 ;;
esac
SMOKE_HOST="${SMOKE_HOST:-localhost}"
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
export DEMO_ERP_API_KEY="${DEMO_ERP_API_KEY:-smoke-erp-key}"
# 身分連結的簽章金鑰（ADR 0042）：release 沒有它就起不來。
export COMMERCE_SIGNING_KEY_K1="${COMMERCE_SIGNING_KEY_K1:-c21va2Utc2lnbmluZy1rZXktMzItYnl0ZXMtMDAwMDE}"
export STOREWEAVE_SIGNING_KEY_K1="${STOREWEAVE_SIGNING_KEY_K1:-c21va2Utc2lnbmluZy1rZXktMzItYnl0ZXMtMDAwMDE}"
KEEP="${KEEP:-false}"
WORK="${SMOKE_WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/storeweave-docker-smoke.XXXXXX")}"
[ -d "$WORK" ] || { echo "Smoke work directory does not exist: $WORK" >&2; exit 1; }
compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }
cleanup() {
  if [ "$KEEP" != true ]; then compose down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
record_smoke_evidence() {
  [ -n "${STOREWEAVE_SMOKE_EVIDENCE:-}" ] || return 0
  local build_info="$WORK/docker-build-info.json"
  local manifest="$WORK/docker-release-manifest.json"
  local container image_digest tag_digest source_revision
  container="$(compose ps -q api)"
  [ -n "$container" ] || { echo 'Smoke API container is not running' >&2; return 1; }
  image_digest="$(docker inspect --format '{{.Image}}' "$container")"
  tag_digest="$(docker image inspect --format '{{.Id}}' "$STOREWEAVE_IMAGE")"
  [ "$image_digest" = "$tag_digest" ] || { echo "Smoke image changed during the run: container=$image_digest tag=$tag_digest" >&2; return 1; }
  docker cp "$container:/opt/$NAME/current/build-info.json" "$build_info"
  docker cp "$container:/opt/$NAME/current/release-manifest.json" "$manifest"
  source_revision="$STOREWEAVE_SOURCE_REVISION"
  node scripts/record-smoke-evidence.mjs \
    --kind docker \
    --release "$RELEASE_ID" \
    --build-info "$build_info" \
    --manifest "$manifest" \
    --artifact-name "$STOREWEAVE_IMAGE" \
    --artifact-digest "$image_digest" \
    --output "$STOREWEAVE_SMOKE_EVIDENCE" \
    --source-revision "$source_revision"
}
if [ "$RELEASE_ID" = base ]; then
  cat > "$WORK/base.yaml" <<'CONFIG'
version: 1
store: { id: base-smoke, name: Base Smoke }
database: { url: '${STOREWEAVE_DATABASE_URL}' }
security:
  signingKeys: [{ id: k1, secretRef: STOREWEAVE_SIGNING_KEY_K1 }]
extensions: []
CONFIG
  export STOREWEAVE_CONFIG_PATH="$WORK/base.yaml"
fi
if [ "${STOREWEAVE_SKIP_BUILD:-false}" = true ]; then
  docker image inspect "$STOREWEAVE_IMAGE" >/dev/null
  compose up -d
else
  compose up -d --build
fi
for i in $(seq 1 90); do
  if curl --max-time 3 -fsS "http://$SMOKE_HOST:$PORT/health/ready" >/dev/null 2>&1; then break; fi
  [ "$i" -lt 90 ] || { echo 'API did not become ready' >&2; compose logs --tail 60 api; exit 1; }
  sleep 2
done
# Token 不再寫在設定檔：由 CLI 現場簽發，秘密只在標準輸出出現一次（ADR 0043）。
secret_of() { sed -n 's/.*"secret":"\([^"]*\)".*/\1/p'; }
full_recovery_smoke() {
  # Keep the bundle outside Compose volumes: the next step deliberately removes
  # every named volume before recovering it into a newly-created cluster.
  local object_payload object_id object_sha job_id occurrence_id scheduled_for job_payload expected_job actual_job storage_key actual_sha backup_container restore_container
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
    | compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
      -v job_id="$job_id" -v occurrence_id="$occurrence_id" -v payload="$job_payload" >/dev/null

  compose stop api worker >/dev/null
  # Write the bundle into the container's own (0700, uid-999-owned) storage and
  # pull it out with `docker cp` instead of bind-mounting $WORK: a bind mount
  # wide enough for the container to write full.bundle would also let any other
  # local user on the host replace it before restore reads it back (H4).
  backup_container="$PROJECT-full-backup"
  compose run --no-deps -T --name "$backup_container" api "$NAME" backup --include-media --external-writers-stopped --out "/var/lib/$NAME/backups/full.bundle"
  docker cp "$backup_container:/var/lib/$NAME/backups/full.bundle" "$WORK/full.bundle"
  docker rm -f "$backup_container" >/dev/null
  [ -f "$WORK/full.bundle/manifest.json" ] || { echo 'Full backup did not produce a bundle manifest' >&2; return 1; }

  # This is intentionally an existing-but-empty live database: it exercises
  # the journaled existing-live cutover rather than only the clean shortcut.
  compose down -v >/dev/null
  compose up -d postgres
  for i in $(seq 1 60); do
    if compose exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
    [ "$i" -lt 60 ] || { echo 'Fresh Postgres did not start' >&2; return 1; }
    sleep 1
  done
  restore_container="$PROJECT-full-restore"
  compose run --no-deps -d --name "$restore_container" --entrypoint sleep api infinity >/dev/null
  docker cp "$WORK/full.bundle" "$restore_container:/tmp/full.bundle"
  docker exec --user root "$restore_container" chown -R "$NAME:$NAME" /tmp/full.bundle
  docker exec --user "$NAME" "$restore_container" "$NAME" restore --bundle /tmp/full.bundle --maintenance-database postgres --yes --external-writers-stopped
  docker rm -f "$restore_container" >/dev/null
  compose up -d api
  for i in $(seq 1 60); do
    if curl --max-time 2 -fsS "http://$SMOKE_HOST:$PORT/health/ready" >/dev/null 2>&1; then break; fi
    [ "$i" -lt 60 ] || { echo 'Recovered API did not become ready' >&2; return 1; }
    sleep 1
  done
  storage_key="$(printf '%s\n' "SELECT storage_key FROM public.platform_storage_objects WHERE id = :'object_id'::uuid;" \
    | compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -v object_id="$object_id" -At)"
  actual_sha="$(compose exec -T api sh -c "sha256sum '/var/lib/$NAME/storage/objects/$storage_key' | cut -d ' ' -f1")"
  expected_job="$job_id|$occurrence_id|platform.media.cleanup-orphans|pending|1|b15-smoke-recovery|1|$scheduled_for"
  actual_job="$(printf '%s\n' "SELECT concat_ws('|', id::text, occurrence_id::text, type, status, payload_version::text, coalesce(dedupe_key, ''), payload->>'bucket', payload->>'scheduledFor') FROM public.platform_jobs WHERE id = :'job_id'::uuid;" \
    | compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -v job_id="$job_id" -At)"
  [ "$actual_sha" = "$object_sha" ] || { echo "Recovered media SHA mismatch: expected $object_sha, got $actual_sha" >&2; return 1; }
  [ "$actual_job" = "$expected_job" ] || { echo "Recovered job mismatch: expected $expected_job, got $actual_job" >&2; return 1; }
  printf 'Full Docker recovery passed (media SHA and pending job restored)\n'
}
compose exec -T api "$NAME" extension:list
# The same selected seed is shipped in the image and remains safe to repeat.
compose exec -T api /usr/local/bin/entrypoint.sh seed
compose exec -T api /usr/local/bin/entrypoint.sh seed
if [ "$RELEASE_ID" = commerce ]; then
  SMOKE_USER_EMAIL=smoke@example.com
  SMOKE_USER_PASSWORD=smoke-user-passphrase-2026
  compose exec -T -e COMMERCE_USER_PASSWORD="$SMOKE_USER_PASSWORD" api "$NAME" user:create \
    --email "$SMOKE_USER_EMAIL" --name 'Smoke operator' --role admin >/dev/null
  ADMIN_TOKEN="$(compose exec -T api "$NAME" token:create --name smoke-admin --role admin --json | secret_of)"
  MCP_TOKEN="$(compose exec -T api "$NAME" token:create --name smoke-mcp --role mcp --json | secret_of)"
  [ -n "$ADMIN_TOKEN" ] || { echo 'token:create did not return a secret' >&2; exit 1; }
  BASE_URL="http://$SMOKE_HOST:$PORT" ADMIN_TOKEN="$ADMIN_TOKEN" MCP_TOKEN="$MCP_TOKEN" \
    SMOKE_USER_EMAIL="$SMOKE_USER_EMAIL" SMOKE_USER_PASSWORD="$SMOKE_USER_PASSWORD" bash scripts/smoke.sh
  full_recovery_smoke
else
  ADMIN_TOKEN="$(compose exec -T api "$NAME" token:create --name smoke-admin --role admin --json | secret_of)"
  [ -n "$ADMIN_TOKEN" ] || { echo 'token:create did not return a secret' >&2; exit 1; }
  BASE_URL="http://$SMOKE_HOST:$PORT" ADMIN_TOKEN="$ADMIN_TOKEN" bash scripts/smoke-base.sh
  compose exec -T api sh -c 'test ! -e /opt/storeweave/current/admin && test ! -e /opt/storeweave/current/theme-assets && test ! -e /etc/commerce && test ! -e /opt/commerce'
  full_recovery_smoke
fi
record_smoke_evidence
printf 'Docker %s smoke passed (%s)\n' "$RELEASE_ID" "$PROJECT"
