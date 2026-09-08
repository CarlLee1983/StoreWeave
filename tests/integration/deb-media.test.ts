import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer } from 'testcontainers';
import { expect, it } from 'vitest';

it('dpkg manages only release media and coexists with legacy packages owning live files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'storeweave-deb-media-'));
  try {
    const script = readFileSync('scripts/build-release.sh', 'utf8');
    // Exercise the actual packaging block with a small archive; native artifact validation has its own suite.
    writeFileSync(join(root, 'package.sh'), 'set -eu\n' + script.slice(script.indexOf('if [ "$ARCH" = x64 ]')));
    const container = await new GenericContainer('node:22').withCopyDirectoriesToContainer([{ source: root, target: '/work' }])
      .withCommand(['sleep', 'infinity']).start();
    try {
      const result = await container.exec(['bash', '-ec', `
        dpkg --add-architecture amd64
        mkdir -p /opt/commerce/releases/old /etc/commerce /var/lib/commerce /var/log/commerce
        echo preserve > /opt/commerce/releases/old/data
        ln -s /opt/commerce/releases/old /opt/commerce/current
        echo secret-fixture > /etc/commerce/commerce.env
        snapshot() { find /opt/commerce /etc/commerce /var/lib/commerce /var/log/commerce -printf '%p %i %m %l\\n'; sha256sum /opt/commerce/releases/old/data /etc/commerce/commerce.env; }
        mkdir -p /legacy/DEBIAN /legacy/opt/commerce/releases/legacy
        printf 'Package: commerce\\nVersion: 0.1.0\\nArchitecture: amd64\\nMaintainer: Fixture <fixture@example.com>\\nDescription: legacy fixture\\n' > /legacy/DEBIAN/control
        echo legacy > /legacy/opt/commerce/releases/legacy/data
        dpkg-deb --build /legacy /legacy.deb
        dpkg -i /legacy.deb
        snapshot > /before
        for version in 1.0.0 1.0.1; do
          mkdir -p /output/$version /input
          echo fixture > /input/README
          tar -czf /output/$version/commerce-$version.tar.gz -C /input README
          ARCH=x64 NAME=commerce RELEASE_ID=commerce VERSION=$version RELEASE_ROOT=/output/$version TARBALL=/output/$version/commerce-$version.tar.gz bash /work/package.sh
          dpkg --unpack /output/$version/commerce-release-media_"$version"_amd64.deb
          dpkg --configure commerce-release-media
          dpkg-reconfigure -f noninteractive commerce-release-media
          snapshot > /after
          cmp /before /after
          cmp /output/$version/commerce-$version.tar.gz /usr/lib/storeweave-release-media/commerce/$version/commerce-$version.tar.gz
          if dpkg-query -L commerce-release-media | grep -Ev '^(/\.|/usr|/usr/lib|/usr/lib/storeweave-release-media|/usr/lib/storeweave-release-media/commerce(/.*)?)$'; then exit 1; fi
          if [ "$version" = 1.0.1 ]; then test ! -e /usr/lib/storeweave-release-media/commerce/1.0.0; fi
        done
        dpkg --purge commerce-release-media
        snapshot > /after
        cmp /before /after
        test "$(cat /opt/commerce/releases/legacy/data)" = legacy
        test ! -e /usr/lib/storeweave-release-media/commerce

      `]);
      expect(result.exitCode, result.output).toBe(0);
    } finally { await container.stop(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
