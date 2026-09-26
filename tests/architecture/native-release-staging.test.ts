import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

const releases = {
  base: {
    name: 'storeweave',
    configs: [
      ['deployments/storeweave.example.yaml', 'storeweave.yaml.example'],
      ['deployments/storeweave.env.example', 'storeweave.env.example'],
    ],
    smoke: 'scripts/smoke-base.sh',
    services: ['deployments/systemd/storeweave-api.service', 'deployments/systemd/storeweave-worker.service'],
    admin: false,
  },
  commerce: {
    name: 'commerce',
    configs: [
      ['deployments/example-store/commerce.yaml', 'commerce.yaml.example'],
      ['deployments/example-store/commerce.env.example', 'commerce.env.example'],
      ['deployments/example-store-two/commerce.yaml', 'commerce.yaml.second-store-example'],
    ],
    smoke: 'scripts/smoke.sh',
    services: ['deployments/systemd/commerce-api.service', 'deployments/systemd/commerce-worker.service'],
    admin: true,
  },
} as const;

describe('native release staging', () => {
  it.each(Object.entries(releases))('%s stages the catalog-selected package assets', (releaseId, plan) => {
    const root = mkdtempSync(join(tmpdir(), 'storeweave-native-staging-'));
    const bin = join(root, 'bin');
    const cache = join(root, 'cache');
    const nodeDist = join(cache, 'node-v22.17.1-linux-arm64');
    const build = join(root, 'build');
    const releaseDir = join(root, 'release');
    mkdirSync(bin);
    mkdirSync(join(nodeDist, 'bin'), { recursive: true });
    writeFileSync(join(cache, 'node-v22.17.1-linux-arm64.tar.xz'), 'fixture');
    writeFileSync(join(nodeDist, 'bin/node'), 'fixture node');
    writeFileSync(join(nodeDist, 'LICENSE'), 'fixture license');
    writeFileSync(join(bin, 'node'), [
      '#!/bin/sh',
      'if [ "$1" = "scripts/build.mjs" ]; then',
      '  mkdir -p "$STOREWEAVE_BUILD_DIR/app" "$STOREWEAVE_BUILD_DIR/scripts"',
      '  for entry in api worker cli seed; do printf "%s\\n" "$STOREWEAVE_RELEASE" > "$STOREWEAVE_BUILD_DIR/app/$entry.js"; done',
      '  printf "%s\\n" "$STOREWEAVE_RELEASE" > "$STOREWEAVE_BUILD_DIR/scripts/validate-release.js"',
      '  printf "1.2.3-test\\n" > "$STOREWEAVE_BUILD_DIR/VERSION"',
      '  printf "{\\"releaseId\\":\\"%s\\"}\\n" "$STOREWEAVE_RELEASE" > "$STOREWEAVE_BUILD_DIR/build-info.json"',
      '  printf "{\\"releaseId\\":\\"%s\\"}\\n" "$STOREWEAVE_RELEASE" > "$STOREWEAVE_BUILD_DIR/release-manifest.json"',
      '  printf "{}" > "$STOREWEAVE_BUILD_DIR/release-manifest.js.meta.json"',
      '  if [ "$STOREWEAVE_RELEASE" = commerce ]; then mkdir -p "$STOREWEAVE_BUILD_DIR/admin"; printf "commerce admin\\n" > "$STOREWEAVE_BUILD_DIR/admin/index.html"; fi',
      '  exit 0',
      'fi',
      'exec "$STOREWEAVE_REAL_NODE" "$@"',
      '',
    ].join('\n'));
    writeFileSync(join(bin, 'tar'), [
      '#!/bin/sh',
      'case " $* " in *" --version "*) exit 1 ;; esac',
      'archive=',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-czf" ]; then archive="$2"; break; fi',
      '  shift',
      'done',
      '[ -n "$archive" ] || exit 1',
      ': > "$archive"',
      '',
    ].join('\n'));
    writeFileSync(join(bin, 'du'), '#!/bin/sh\nprintf "0\\n"\n');
    for (const file of [join(bin, 'node'), join(bin, 'tar'), join(bin, 'du')]) {
      execFileSync('chmod', ['+x', file]);
    }

    try {
      execFileSync('/bin/bash', ['scripts/build-release.sh'], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          STOREWEAVE_REAL_NODE: process.execPath,
          STOREWEAVE_RELEASE: releaseId,
          STOREWEAVE_RELEASE_VERSION: '1.2.3-test',
          STOREWEAVE_NODE_VERSION: '22.17.1',
          STOREWEAVE_TARGET_ARCH: 'arm64',
          STOREWEAVE_BUILD_DIR: build,
          STOREWEAVE_RELEASE_DIR: releaseDir,
          STOREWEAVE_CACHE_DIR: cache,
        },
        stdio: 'pipe',
        timeout: 30_000,
      });

      const stage = join(releaseDir, `${plan.name}-1.2.3-test`);
      expect(existsSync(join(releaseDir, `${plan.name}-1.2.3-test.tar.gz`))).toBe(true);
      expect(readdirSync(join(stage, 'config')).sort()).toEqual(plan.configs.map(([, filename]) => filename).sort());
      for (const [source, filename] of plan.configs) {
        expect(readFileSync(join(stage, 'config', filename))).toEqual(readFileSync(join(ROOT, source)));
      }
      expect(readFileSync(join(stage, 'scripts/smoke.sh'))).toEqual(readFileSync(join(ROOT, plan.smoke)));
      for (const service of plan.services) {
        expect(readFileSync(join(stage, 'systemd', service.split('/').at(-1)!))).toEqual(readFileSync(join(ROOT, service)));
      }
      expect(existsSync(join(stage, 'admin/index.html'))).toBe(plan.admin);
      expect(JSON.parse(readFileSync(join(stage, 'native-layout.json'), 'utf8'))).toEqual({
        schemaVersion: 1, releaseId, name: plan.name,
        assets: { admin: plan.admin, themeAssets: false },
      });
      expect(JSON.parse(readFileSync(join(stage, 'build-info.json'), 'utf8')).nativeLayoutVersion).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
