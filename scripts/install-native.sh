#!/usr/bin/env bash
# 在乾淨的 Ubuntu / Debian x86-64 主機上安裝 StoreWeave。
# 主機不需要事先安裝 Node.js —— Release 內含固定版本的 Node runtime。
set -euo pipefail

RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(cat "$RELEASE_DIR/VERSION")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid release version' >&2; exit 1; }
RELEASE_ID="$(cat "$RELEASE_DIR/RELEASE")"
case "$RELEASE_ID" in
  commerce) NAME=commerce ;;
  base) NAME=storeweave ;;
  *) echo 'Unknown release identity' >&2; exit 1 ;;
esac
PREFIX="/opt/$NAME"
TARGET="$PREFIX/releases/$VERSION"

[ "$(id -u)" -eq 0 ] || { echo "請以 root 執行（sudo ./scripts/install.sh）"; exit 1; }

if [ ! -e "$PREFIX" ] && [ ! -L "$PREFIX" ]; then mkdir -m 0755 "$PREFIX"; fi
[ -d "$PREFIX" ] && [ ! -L "$PREFIX" ] && [ "$(stat -c %u "$PREFIX")" = 0 ] && (( (8#$(stat -c %a "$PREFIX") & 8#022) == 0 )) || { echo 'Unsafe installation home' >&2; exit 1; }
LOCK="$PREFIX/.transition.lock"
if [ ! -e "$LOCK" ] && [ ! -L "$LOCK" ]; then (umask 077; set -C; : > "$LOCK"); fi
[ -f "$LOCK" ] && [ ! -L "$LOCK" ] && [ "$(stat -c %u "$LOCK")" = 0 ] && [ "$(stat -c %h "$LOCK")" = 1 ] && (( (8#$(stat -c %a "$LOCK") & 8#022) == 0 )) || { echo 'Unsafe transition lock' >&2; exit 1; }
# Share the same persistent kernel lock as CLI transitions; closing this process releases it.
exec 9<>"$PREFIX/.transition.lock"
flock -n 9 || { echo 'Another installation or release transition is running' >&2; exit 1; }

[ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || { echo "Release already installed: $TARGET" >&2; exit 1; }
[ ! -e "$PREFIX/current" ] && [ ! -L "$PREFIX/current" ] || { echo 'Existing installation: use the upgrade command' >&2; exit 1; }
[ -x "$RELEASE_DIR/runtime/bin/node" ] && [ -f "$RELEASE_DIR/app/cli.js" ] || { echo 'Incomplete release' >&2; exit 1; }
"$RELEASE_DIR/runtime/bin/node" "$RELEASE_DIR/scripts/validate-release.js" "$RELEASE_DIR" "$RELEASE_ID" >/dev/null

echo "==> 建立 $NAME 使用者與目錄"
getent group ${NAME} >/dev/null || groupadd --system ${NAME}
getent passwd ${NAME} >/dev/null || useradd --system --gid ${NAME} --home /var/lib/${NAME} --shell /usr/sbin/nologin ${NAME}
mkdir -p "$PREFIX/releases" /etc/${NAME} /var/lib/${NAME}/backups /var/log/${NAME}
chown -R ${NAME}:${NAME} /var/lib/${NAME} /var/log/${NAME}

echo "==> 安裝程式到 $TARGET"
"$RELEASE_DIR/runtime/bin/node" "$RELEASE_DIR/scripts/validate-release.js" "$RELEASE_DIR" "$RELEASE_ID" "$PREFIX/releases" >/dev/null

echo "==> 安裝設定範本"
[ -f /etc/${NAME}/${NAME}.yaml ] || cp "$TARGET/config/${NAME}.yaml.example" /etc/${NAME}/${NAME}.yaml
if [ ! -f /etc/${NAME}/${NAME}.env ]; then
  cp "$TARGET/config/${NAME}.env.example" /etc/${NAME}/${NAME}.env
  chmod 0640 /etc/${NAME}/${NAME}.env
  echo "    已建立 /etc/${NAME}/${NAME}.env —— 請填入真正的機密後再啟動服務"
fi
chown -R root:${NAME} /etc/${NAME}
chmod 0750 /etc/${NAME}

echo "==> 切換 current symlink"
# Create exclusively: an installation appearing after preflight must never be overwritten.
ln -sT "$TARGET" "$PREFIX/current"
ln -sf "$PREFIX/current/bin/${NAME}" /usr/local/bin/${NAME}

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  echo "==> 安裝 systemd unit"
  cp "$TARGET/systemd/"*.service /lib/systemd/system/
  systemctl daemon-reload
  systemctl enable ${NAME}-api.service ${NAME}-worker.service >/dev/null
else
  echo "==> 這個環境沒有 systemd，略過 unit 安裝"
  echo "    unit 檔仍在 $TARGET/systemd/，需要時可自行複製到 /lib/systemd/system"
  echo "    ${NAME} start/stop/status 會自動退回 pid file 模式"
fi

cat <<TXT

安裝完成（${VERSION}）。

下一步：
  1. 編輯 /etc/${NAME}/${NAME}.env，填入範本列出的連線與機密
  2. 編輯 /etc/${NAME}/${NAME}.yaml，調整網站設定
  3. sudo -u ${NAME} ${NAME} install --skip-migrate   # 檢查設定
  4. sudo -u ${NAME} ${NAME} migrate                  # 套用資料庫 schema
  5. sudo systemctl start ${NAME}-api ${NAME}-worker   # 沒有 systemd 時用 ${NAME} start
  6. sudo -u ${NAME} ${NAME} doctor

記錄：journalctl -u ${NAME}-api -f
TXT
