#!/usr/bin/env bash
# 產生 Native Linux Release tarball（如環境允許，另外產生 .deb）。
#
# Release 內含：固定版本的 Node runtime、已編譯的 JavaScript、Admin 靜態資源、
# Theme、Migration 與 Extension。正式主機不需要 Node.js、pnpm 或 TypeScript。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RELEASE_ID="${STOREWEAVE_RELEASE:-commerce}"
case "$RELEASE_ID" in
  commerce) NAME=commerce ;;
  base) NAME=storeweave ;;
  file-requests) NAME=storeweave-file-requests ;;
  *) echo "Unknown release: $RELEASE_ID" >&2; exit 1 ;;
esac
VERSION="${STOREWEAVE_RELEASE_VERSION:-${COMMERCE_RELEASE_VERSION:-$(node -p "require('./package.json').version")}}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid release version' >&2; exit 1; }
NODE_VERSION="${STOREWEAVE_NODE_VERSION:-${COMMERCE_NODE_VERSION:-22.17.1}}"
ARCH="${STOREWEAVE_TARGET_ARCH:-${COMMERCE_TARGET_ARCH:-x64}}"
case "$ARCH" in x64|arm64) ;; *) echo 'Unsupported Node architecture' >&2; exit 1 ;; esac
NODE_DIST="node-v${NODE_VERSION}-linux-${ARCH}"
CACHE_DIR="$ROOT/.cache"
BUILD_DIR="${STOREWEAVE_BUILD_DIR:-$ROOT/dist}"
RELEASE_ROOT="${STOREWEAVE_RELEASE_DIR:-$ROOT/release}"
STAGE="$RELEASE_ROOT/$NAME-$VERSION"
[ ! -e "$STAGE" ] || { echo "Release already exists: $STAGE" >&2; exit 1; }
for artifact in "$STAGE.tar.gz" "$RELEASE_ROOT/${NAME}-release-media_${VERSION}_amd64.deb" "$RELEASE_ROOT/deb/${NAME}-release-media_${VERSION}_amd64"; do
  [ ! -e "$artifact" ] || { echo "Release artifact already exists: $artifact" >&2; exit 1; }
done
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
mkdir -p "$STAGE"/{app,bin,config,systemd,scripts}

cp -R "$BUILD_DIR/app/." "$STAGE/app/"
cp -R "$BUILD_DIR/scripts/." "$STAGE/scripts/"
[ ! -d "$BUILD_DIR/admin" ] || cp -R "$BUILD_DIR/admin" "$STAGE/admin"
# The bundled API resolves theme media beside the release root. Keep this
# explicit rather than relying on source-tree fallbacks that do not exist on a
# production host.
[ ! -d "$BUILD_DIR/theme-assets" ] || cp -R "$BUILD_DIR/theme-assets" "$STAGE/theme-assets"
cp "$BUILD_DIR/VERSION" "$BUILD_DIR/build-info.json" "$STAGE/"
cp "$BUILD_DIR/release-manifest.json" "$BUILD_DIR/release-manifest.js.meta.json" "$STAGE/"
printf '%s\n' "$RELEASE_ID" > "$STAGE/RELEASE"

# 固定版本的 Node runtime，只留執行所需的部分
mkdir -p "$STAGE/runtime"
cp -R "$CACHE_DIR/$NODE_DIST/bin" "$STAGE/runtime/"
cp -R "$CACHE_DIR/$NODE_DIST/lib" "$STAGE/runtime/" 2>/dev/null || true
cp "$CACHE_DIR/$NODE_DIST/LICENSE" "$STAGE/runtime/NODE-LICENSE" 2>/dev/null || true
rm -f "$STAGE/runtime/bin/npm" "$STAGE/runtime/bin/npx" "$STAGE/runtime/bin/corepack"

if [ "$RELEASE_ID" = commerce ]; then
  cp deployments/example-store/commerce.yaml "$STAGE/config/$NAME.yaml.example"
  cp deployments/example-store/commerce.env.example "$STAGE/config/$NAME.env.example"
  cp deployments/example-store-two/commerce.yaml "$STAGE/config/$NAME.yaml.second-store-example"
  cp scripts/smoke.sh "$STAGE/scripts/smoke.sh"
else
  cp deployments/storeweave.example.yaml "$STAGE/config/storeweave.yaml.example"
  cp deployments/storeweave.env.example "$STAGE/config/storeweave.env.example"
  cp scripts/smoke-base.sh "$STAGE/scripts/smoke.sh"
fi
cp "deployments/systemd/$NAME-api.service" "deployments/systemd/$NAME-worker.service" "$STAGE/systemd/"
cp scripts/install-native.sh "$STAGE/scripts/install.sh"
chmod +x "$STAGE/scripts/"*.sh

cat > "$STAGE/bin/$NAME" <<'WRAPPER'
#!/bin/sh
# 統一 CLI 入口。使用 Release 內附的 Node runtime，不依賴主機上的 Node.js。
# 安裝的 CLI 是 symlink，先解析才能找到這一版的 runtime 與 app。
TARGET="$0"
while [ -L "$TARGET" ]; do
  LINK="$(readlink "$TARGET")"
  case "$LINK" in
    /*) TARGET="$LINK" ;;
    *)  TARGET="$(dirname "$TARGET")/$LINK" ;;
  esac
done
SELF="$(cd "$(dirname "$TARGET")/.." && pwd)"
export STOREWEAVE_RELEASE_VERSION="$(cat "$SELF/VERSION" 2>/dev/null || echo unknown)"
exec "$SELF/runtime/bin/node" "$SELF/app/cli.js" "$@"
WRAPPER
chmod +x "$STAGE/bin/$NAME"

cat > "$STAGE/README.txt" <<TXT
StoreWeave $RELEASE_ID $VERSION
Node runtime: v$NODE_VERSION (linux-$ARCH, 內附)

安裝：
  sudo ./scripts/install.sh

安裝後：
  sudo -u $NAME /opt/$NAME/current/bin/$NAME doctor
  sudo systemctl status $NAME-api $NAME-worker
TXT

echo "==> packaging tarball"
TARBALL="$RELEASE_ROOT/$NAME-$VERSION.tar.gz"
# macOS 的 bsdtar 預設會塞入 xattr，會在 Linux 上產生大量警告
TAR_FLAGS=""
if tar --no-xattrs --version >/dev/null 2>&1; then TAR_FLAGS="--no-xattrs"; fi
COPYFILE_DISABLE=1 tar $TAR_FLAGS -czf "$TARBALL" -C "$RELEASE_ROOT" "$NAME-$VERSION"
echo "    $TARBALL ($(du -h "$TARBALL" | cut -f1))"

if [ "$ARCH" = x64 ] && command -v dpkg-deb >/dev/null 2>&1; then
  echo "==> building .deb"
  DEB_ROOT="$RELEASE_ROOT/deb/${NAME}-release-media_${VERSION}_amd64"
  rm -rf "$DEB_ROOT"
  MEDIA="/usr/lib/storeweave-release-media/$NAME/$VERSION"
  mkdir -p "$DEB_ROOT/DEBIAN" "$DEB_ROOT$MEDIA"
  cp "$TARBALL" "$DEB_ROOT$MEDIA/"

  cat > "$DEB_ROOT/DEBIAN/control" <<CTRL
Package: $NAME-release-media
Version: $VERSION
Section: web
Priority: optional
Architecture: amd64
Maintainer: StoreWeave <ops@example.com>
Description: StoreWeave $RELEASE_ID installation media
 Contains a release archive with pinned Node.js. Activation is an explicit
 native installer or CLI upgrade operation; dpkg does not manage live releases.
CTRL

  cat > "$DEB_ROOT$MEDIA/README.txt" <<TXT
StoreWeave $RELEASE_ID $VERSION installation media
Archive: $MEDIA/$NAME-$VERSION.tar.gz

This package does not install or activate a running release.
Fresh installation: extract this archive into a root-owned 0700 directory, then
run its $NAME-$VERSION/scripts/install.sh as root.
Existing installation: follow the documented CLI upgrade procedure using this archive.
B01 installations require the explicit --from-legacy-b01 bridge from the extracted candidate CLI.
Removing this package removes only installation media; preserve the archive before removal if needed.
TXT

  dpkg-deb --build --root-owner-group "$DEB_ROOT" "$RELEASE_ROOT/${NAME}-release-media_${VERSION}_amd64.deb" >/dev/null
  echo "    $RELEASE_ROOT/${NAME}-release-media_${VERSION}_amd64.deb"
else
  echo "==> dpkg-deb not available; skipping .deb (tarball is enough)"
fi

echo
echo "release ready: $RELEASE_ROOT"
