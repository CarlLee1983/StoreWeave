#!/usr/bin/env bash
# 產生 Native Linux Release tarball（如環境允許，另外產生 .deb）。
#
# Release 內含：固定版本的 Node runtime、已編譯的 JavaScript、Admin 靜態資源、
# Theme、Migration 與 Extension。正式主機不需要 Node.js、pnpm 或 TypeScript。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${COMMERCE_RELEASE_VERSION:-$(node -p "require('./package.json').version")}"
NODE_VERSION="${COMMERCE_NODE_VERSION:-22.17.1}"
ARCH="${COMMERCE_TARGET_ARCH:-x64}"
NODE_DIST="node-v${NODE_VERSION}-linux-${ARCH}"
CACHE_DIR="$ROOT/.cache"
RELEASE_ROOT="$ROOT/release"
STAGE="$RELEASE_ROOT/commerce-$VERSION"
SKIP_ADMIN="${SKIP_ADMIN:-false}"

echo "==> building application artifact ($VERSION)"
if [ "$SKIP_ADMIN" = "true" ]; then
  node scripts/build.mjs --skip-admin
else
  node scripts/build.mjs
fi

echo "==> fetching pinned node runtime ($NODE_DIST)"
mkdir -p "$CACHE_DIR"
if [ ! -f "$CACHE_DIR/$NODE_DIST.tar.xz" ]; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz" -o "$CACHE_DIR/$NODE_DIST.tar.xz"
fi
if [ ! -d "$CACHE_DIR/$NODE_DIST" ]; then
  tar -xJf "$CACHE_DIR/$NODE_DIST.tar.xz" -C "$CACHE_DIR"
fi

echo "==> staging release"
rm -rf "$STAGE"
mkdir -p "$STAGE"/{app,bin,config,systemd,scripts}

cp -R dist/app/. "$STAGE/app/"
[ -d dist/admin ] && cp -R dist/admin "$STAGE/admin"
[ -d dist/theme-assets ] && cp -R dist/theme-assets "$STAGE/theme-assets"
node scripts/theme-assets.mjs verify --assets "$STAGE/theme-assets/default"
cp dist/VERSION dist/build-info.json "$STAGE/"

# 固定版本的 Node runtime，只留執行所需的部分
mkdir -p "$STAGE/runtime"
cp -R "$CACHE_DIR/$NODE_DIST/bin" "$STAGE/runtime/"
cp -R "$CACHE_DIR/$NODE_DIST/lib" "$STAGE/runtime/" 2>/dev/null || true
cp "$CACHE_DIR/$NODE_DIST/LICENSE" "$STAGE/runtime/NODE-LICENSE" 2>/dev/null || true
rm -f "$STAGE/runtime/bin/npm" "$STAGE/runtime/bin/npx" "$STAGE/runtime/bin/corepack"

cp deployments/example-store/commerce.yaml "$STAGE/config/commerce.yaml.example"
cp deployments/example-store/commerce.env.example "$STAGE/config/commerce.env.example"
cp deployments/example-store-two/commerce.yaml "$STAGE/config/commerce.yaml.second-store-example"
cp deployments/systemd/commerce-api.service deployments/systemd/commerce-worker.service "$STAGE/systemd/"
cp scripts/smoke.sh "$STAGE/scripts/smoke.sh"
cp scripts/install-native.sh "$STAGE/scripts/install.sh"
chmod +x "$STAGE/scripts/"*.sh

cat > "$STAGE/bin/commerce" <<'WRAPPER'
#!/bin/sh
# 統一 CLI 入口。使用 Release 內附的 Node runtime，不依賴主機上的 Node.js。
# /usr/local/bin/commerce 是指向 /opt/commerce/current/bin/commerce 的 symlink，
# 因此要先解析 symlink 才能找到這一版的 runtime 與 app。
TARGET="$0"
while [ -L "$TARGET" ]; do
  LINK="$(readlink "$TARGET")"
  case "$LINK" in
    /*) TARGET="$LINK" ;;
    *)  TARGET="$(dirname "$TARGET")/$LINK" ;;
  esac
done
SELF="$(cd "$(dirname "$TARGET")/.." && pwd)"
export COMMERCE_RELEASE_VERSION="$(cat "$SELF/VERSION" 2>/dev/null || echo unknown)"
exec "$SELF/runtime/bin/node" "$SELF/app/cli.js" "$@"
WRAPPER
chmod +x "$STAGE/bin/commerce"

cat > "$STAGE/README.txt" <<TXT
StoreWeave Commerce $VERSION
Node runtime: v$NODE_VERSION (linux-$ARCH, 內附)

安裝：
  sudo ./scripts/install.sh

安裝後：
  sudo -u commerce /opt/commerce/current/bin/commerce doctor
  sudo systemctl status commerce-api commerce-worker
TXT

echo "==> packaging tarball"
TARBALL="$RELEASE_ROOT/commerce-$VERSION.tar.gz"
# macOS 的 bsdtar 預設會塞入 xattr，會在 Linux 上產生大量警告
TAR_FLAGS=""
if tar --no-xattrs --version >/dev/null 2>&1; then TAR_FLAGS="--no-xattrs"; fi
COPYFILE_DISABLE=1 tar $TAR_FLAGS -czf "$TARBALL" -C "$RELEASE_ROOT" "commerce-$VERSION"
TARBALL_CONTENTS="$(tar -tzf "$TARBALL")"
while IFS= read -r THEME_ASSET; do
  grep -Fqx "commerce-$VERSION/theme-assets/default/$THEME_ASSET" <<< "$TARBALL_CONTENTS"
done < <(node scripts/theme-assets.mjs list)
echo "    $TARBALL ($(du -h "$TARBALL" | cut -f1))"

if command -v dpkg-deb >/dev/null 2>&1; then
  echo "==> building .deb"
  DEB_ROOT="$RELEASE_ROOT/deb/commerce_${VERSION}_amd64"
  rm -rf "$DEB_ROOT"
  mkdir -p "$DEB_ROOT/DEBIAN" "$DEB_ROOT/opt/commerce/releases/$VERSION" "$DEB_ROOT/lib/systemd/system" "$DEB_ROOT/etc/commerce" "$DEB_ROOT/usr/bin"
  cp -R "$STAGE/." "$DEB_ROOT/opt/commerce/releases/$VERSION/"
  cp "$STAGE/systemd/"*.service "$DEB_ROOT/lib/systemd/system/"
  cp "$STAGE/config/commerce.yaml.example" "$DEB_ROOT/etc/commerce/"
  cp "$STAGE/config/commerce.env.example" "$DEB_ROOT/etc/commerce/"
  ln -sf /opt/commerce/current/bin/commerce "$DEB_ROOT/usr/bin/commerce"

  cat > "$DEB_ROOT/DEBIAN/control" <<CTRL
Package: commerce
Version: $VERSION
Section: web
Priority: optional
Architecture: amd64
Depends: postgresql-client
Maintainer: StoreWeave <ops@example.com>
Description: StoreWeave single-tenant commerce platform
 Ships its own pinned Node.js runtime; the host needs no Node.js toolchain.
CTRL

  cat > "$DEB_ROOT/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
VERSION_DIR="$(ls -1 /opt/commerce/releases | sort -V | tail -1)"
getent group commerce >/dev/null || groupadd --system commerce
getent passwd commerce >/dev/null || useradd --system --gid commerce --home /var/lib/commerce --shell /usr/sbin/nologin commerce
mkdir -p /var/lib/commerce/backups /var/log/commerce /etc/commerce
chown -R commerce:commerce /var/lib/commerce /var/log/commerce
[ -e /opt/commerce/current ] && rm -f /opt/commerce/current
ln -sfn "/opt/commerce/releases/$VERSION_DIR" /opt/commerce/current
systemctl daemon-reload || true
echo "commerce installed. Edit /etc/commerce/commerce.yaml and commerce.env, then run: commerce install"
POSTINST
  chmod 0755 "$DEB_ROOT/DEBIAN/postinst"

  dpkg-deb --build --root-owner-group "$DEB_ROOT" "$RELEASE_ROOT/commerce_${VERSION}_amd64.deb" >/dev/null
  echo "    $RELEASE_ROOT/commerce_${VERSION}_amd64.deb"
else
  echo "==> dpkg-deb not available; skipping .deb (tarball is enough)"
fi

echo
echo "release ready: $RELEASE_ROOT"
