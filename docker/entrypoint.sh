#!/bin/sh
# Docker 與 Native 使用同一份 Application Artifact 與同一份設定格式；
# 這個 entrypoint 只是選擇要跑哪個行程。
set -e

case "$(cat /usr/local/share/storeweave-release)" in
  commerce)
    NAME=commerce
    export STOREWEAVE_HOME="${STOREWEAVE_HOME:-${COMMERCE_HOME:-/opt/commerce}}"
    export STOREWEAVE_CONFIG="${STOREWEAVE_CONFIG:-${COMMERCE_CONFIG:-/etc/commerce/commerce.yaml}}"
    AUTO_MIGRATE="${STOREWEAVE_AUTO_MIGRATE:-${COMMERCE_AUTO_MIGRATE:-true}}"
    DB_URL="${DATABASE_URL:-}"
    ;;
  base)
    NAME=storeweave
    export STOREWEAVE_HOME="${STOREWEAVE_HOME:-/opt/storeweave}"
    export STOREWEAVE_CONFIG="${STOREWEAVE_CONFIG:-/etc/storeweave/storeweave.yaml}"
    AUTO_MIGRATE="${STOREWEAVE_AUTO_MIGRATE:-true}"
    DB_URL="${STOREWEAVE_DATABASE_URL:-}"
    ;;
  *) echo 'Unknown release identity' >&2; exit 1 ;;
esac
APP_DIR="$STOREWEAVE_HOME/current/app"
cd "$STOREWEAVE_HOME/current"

wait_for_database() {
  echo "[entrypoint] waiting for database..."
  i=0
  while [ "$i" -lt 60 ]; do
    if pg_isready -d "$DB_URL" >/dev/null 2>&1; then
      echo "[entrypoint] database is ready"
      return 0
    fi
    i=$((i+1))
    sleep 1
  done
  echo "[entrypoint] database did not become ready in time" >&2
  return 1
}

case "$1" in
  api)
    wait_for_database
    if [ "$AUTO_MIGRATE" = "true" ]; then
      node "$APP_DIR/cli.js" migrate
    fi
    exec node "$APP_DIR/api.js"
    ;;
  worker)
    wait_for_database
    exec node "$APP_DIR/worker.js"
    ;;
  seed)
    shift
    exec node "$APP_DIR/seed.js" "$@"
    ;;
  migrate|doctor|install|status|extension:list|backup|restore)
    exec node "$APP_DIR/cli.js" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
