#!/bin/sh
set -e

export STOREWEAVE_HOME="${STOREWEAVE_HOME:-/opt/notes}"
export STOREWEAVE_CONFIG="${STOREWEAVE_CONFIG:-/etc/notes/notes.yaml}"
APP_DIR="$STOREWEAVE_HOME/current/app"
cd "$STOREWEAVE_HOME/current"

wait_for_database() {
  echo "[entrypoint] waiting for database..."
  i=0
  while [ "$i" -lt 60 ]; do
    if pg_isready -d "${STOREWEAVE_DATABASE_URL:-}" >/dev/null 2>&1; then
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
    if [ "${STOREWEAVE_AUTO_MIGRATE:-true}" = "true" ]; then
      node "$APP_DIR/cli.js" migrate
    fi
    exec node "$APP_DIR/api.js"
    ;;
  worker)
    wait_for_database
    exec node "$APP_DIR/worker.js"
    ;;
  *)
    exec "$@"
    ;;
esac
