#!/usr/bin/env bash
# 在乾淨的 Ubuntu / Debian x86-64 主機上安裝 StoreWeave。
# 主機不需要事先安裝 Node.js —— Release 內含固定版本的 Node runtime。
set -euo pipefail

RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(cat "$RELEASE_DIR/VERSION")"
PREFIX=/opt/commerce
TARGET="$PREFIX/releases/$VERSION"

[ "$(id -u)" -eq 0 ] || { echo "請以 root 執行（sudo ./scripts/install.sh）"; exit 1; }

echo "==> 建立 commerce 使用者與目錄"
getent group commerce >/dev/null || groupadd --system commerce
getent passwd commerce >/dev/null || useradd --system --gid commerce --home /var/lib/commerce --shell /usr/sbin/nologin commerce
mkdir -p "$PREFIX/releases" /etc/commerce /var/lib/commerce/backups /var/log/commerce
chown -R commerce:commerce /var/lib/commerce /var/log/commerce

echo "==> 安裝程式到 $TARGET"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$RELEASE_DIR/." "$TARGET/"

echo "==> 切換 current symlink"
PREVIOUS=""
[ -L "$PREFIX/current" ] && PREVIOUS="$(readlink -f "$PREFIX/current")"
[ -n "$PREVIOUS" ] && echo "$PREVIOUS" > "$PREFIX/previous"
ln -sfn "$TARGET" "$PREFIX/current"
ln -sf "$PREFIX/current/bin/commerce" /usr/local/bin/commerce

echo "==> 安裝設定範本"
[ -f /etc/commerce/commerce.yaml ] || cp "$TARGET/config/commerce.yaml.example" /etc/commerce/commerce.yaml
if [ ! -f /etc/commerce/commerce.env ]; then
  cp "$TARGET/config/commerce.env.example" /etc/commerce/commerce.env
  chmod 0600 /etc/commerce/commerce.env
  echo "    已建立 /etc/commerce/commerce.env —— 請填入真正的機密後再啟動服務"
fi
chown -R root:commerce /etc/commerce
chmod 0750 /etc/commerce

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  echo "==> 安裝 systemd unit"
  cp "$TARGET/systemd/"*.service /lib/systemd/system/
  systemctl daemon-reload
  systemctl enable commerce-api.service commerce-worker.service >/dev/null
else
  echo "==> 這個環境沒有 systemd，略過 unit 安裝"
  echo "    unit 檔仍在 $TARGET/systemd/，需要時可自行複製到 /lib/systemd/system"
  echo "    commerce start/stop/status 會自動退回 pid file 模式"
fi

cat <<TXT

安裝完成（${VERSION}）。

下一步：
  1. 編輯 /etc/commerce/commerce.env，填入 DATABASE_URL 與各項 token
  2. 編輯 /etc/commerce/commerce.yaml，調整店名、Theme 與 Extension
  3. sudo -u commerce commerce install --skip-migrate   # 檢查設定
  4. sudo -u commerce commerce migrate                  # 套用資料庫 schema
  5. sudo systemctl start commerce-api commerce-worker   # 沒有 systemd 時用 commerce start
  6. sudo -u commerce commerce doctor

記錄：journalctl -u commerce-api -f
TXT
