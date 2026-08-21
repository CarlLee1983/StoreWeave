#!/bin/sh
# Docker 與 Native 使用同一份 Application Artifact 與同一份設定格式；
# 這個 entrypoint 只是選擇要跑哪個行程。
set -e

APP_DIR=/opt/commerce/current/app

wait_for_database() {
  echo "[entrypoint] waiting for database..."
  i=0
  while [ "$i" -lt 60 ]; do
    if pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
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
    if [ "${COMMERCE_AUTO_MIGRATE:-true}" = "true" ]; then
      node "$APP_DIR/cli.js" migrate
    fi
    exec node "$APP_DIR/api.js"
    ;;
  worker)
    wait_for_database
    exec node "$APP_DIR/worker.js"
    ;;
  migrate|doctor|install|status|extension:list|backup|restore)
    exec node "$APP_DIR/cli.js" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
