import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_PROJECTION_PROVENANCE,
  createAdminProjectionProvenance,
  resolveBuildProjections,
  resolveRuntimeProjectionSources,
  validateAdminProjectionProvenance,
  validateBuildGraph,
  validateProjectionGraph,
} from '../../scripts/build-projections.mjs';

const ROOT = resolve(__dirname, '../..');
const base = {
  runtime: 'packages/releases/base/src/runtime.ts',
  server: 'packages/releases/base/src/server.ts',
  worker: 'packages/releases/base/src/worker.ts',
  adminProjection: 'packages/releases/base/src/admin.ts',
  cli: 'packages/releases/base/src/cli.ts',
  admin: false,
};

describe('build projections', () => {
  it('resolves release-attributed projections in a stable server, worker, admin, CLI order', () => {
    const first = resolveBuildProjections({ root: ROOT, releaseId: 'base', release: base });
    const second = resolveBuildProjections({ root: ROOT, releaseId: 'base', release: base });

    expect(first).toEqual(second);
    expect(first.map(({ target, source, status }) => ({ target, source, status }))).toEqual([
      { target: 'server', source: base.server, status: 'built' },
      { target: 'worker', source: base.worker, status: 'built' },
      { target: 'admin', source: base.adminProjection, status: 'disabled' },
      { target: 'cli', source: base.cli, status: 'built' },
    ]);
  });

  it('requires each selected projection source to resolve and reports release, target, and source', () => {
    expect(() => resolveBuildProjections({
      root: ROOT,
      releaseId: 'commerce',
      release: { ...base, server: 'packages/releases/commerce/src/missing.ts' },
    })).toThrow('Release "commerce" target "server" projection source is missing: "packages/releases/commerce/src/missing.ts"');
  });

  it('resolves Config and Storefront projection sources as runtime inputs', () => {
    expect(resolveRuntimeProjectionSources({
      root: ROOT,
      releaseId: 'file-requests',
      release: {
        runtime: 'packages/examples/file-requests/src/runtime.ts',
        configProjection: 'packages/examples/file-requests/src/config.ts',
        storefrontProjection: 'packages/examples/file-requests/src/storefront.ts',
      },
      runtimeProjectionSources: {
        config: 'packages/examples/file-requests/src/config.ts',
        storefront: 'packages/examples/file-requests/src/storefront.ts',
      },
    })).toEqual([
      { releaseId: 'file-requests', target: 'config', source: 'packages/examples/file-requests/src/config.ts' },
      { releaseId: 'file-requests', target: 'storefront', source: 'packages/examples/file-requests/src/storefront.ts' },
    ]);
    expect(() => resolveRuntimeProjectionSources({
      root: ROOT,
      releaseId: 'file-requests',
      release: { runtime: 'packages/examples/file-requests/src/runtime.ts', configProjection: 'packages/examples/file-requests/src/missing.ts', storefrontProjection: 'packages/examples/file-requests/src/storefront.ts' },
      runtimeProjectionSources: {
        config: 'packages/examples/file-requests/src/missing.ts',
        storefront: 'packages/examples/file-requests/src/storefront.ts',
      },
    })).toThrow('Release "file-requests" target "config" projection source is missing');
    expect(() => resolveRuntimeProjectionSources({
      root: ROOT,
      releaseId: 'base',
      release: {
        runtime: 'packages/releases/base/src/runtime.ts',
        configProjection: 'packages/releases/commerce/src/config.ts',
        storefrontProjection: 'packages/releases/commerce/src/storefront.ts',
      },
      runtimeProjectionSources: {
        config: 'packages/releases/base/src/config.ts',
        storefront: 'packages/releases/base/src/storefront.ts',
      },
    })).toThrow('Release "base" target "config" projection source mismatch');
  });

  it('rejects an unresolved contribution with target and projection source', () => {
    expect(() => validateProjectionGraph({
      root: ROOT,
      releaseId: 'base',
      target: 'server',
      source: base.server,
      artifact: 'app/api.js',
      inputs: ['apps/api/src/main.ts'],
    })).toThrow('Release "base" target "server" did not resolve projection source "packages/releases/base/src/server.ts"');
  });

  it('rejects a cross-target import and identifies its source path', () => {
    expect(() => validateProjectionGraph({
      root: ROOT,
      releaseId: 'commerce',
      target: 'server',
      source: 'packages/releases/commerce/src/server.ts',
      artifact: 'app/api.js',
      inputs: [
        'apps/api/src/main.ts',
        'packages/releases/commerce/src/server.ts',
        'packages/releases/base/src/worker.ts',
      ],
    })).toThrow('Release "commerce" target "server" imports forbidden source "packages/releases/base/src/worker.ts"');

    expect(() => validateProjectionGraph({
      root: ROOT,
      releaseId: 'commerce',
      target: 'worker',
      source: 'packages/releases/commerce/src/worker.ts',
      artifact: 'app/worker.js',
      inputs: ['packages/releases/commerce/src/worker.ts', 'node_modules/.pnpm/react@19.0.0/node_modules/react/index.js'],
    })).toThrow('Release "commerce" target "worker" imports forbidden source "node_modules/.pnpm/react@19.0.0/node_modules/react/index.js"');
  });

  it('rejects browser persistence/provider imports and release-excluded sources', () => {
    expect(() => validateProjectionGraph({
      root: ROOT,
      releaseId: 'commerce',
      target: 'admin',
      source: 'packages/releases/commerce/src/admin.tsx',
      artifact: 'admin/index.html',
      inputs: ['packages/releases/commerce/src/admin.tsx', 'packages/extensions/ecpay/src/index.ts'],
    })).toThrow('target "admin" imports forbidden source "packages/extensions/ecpay/src/index.ts"');

    expect(() => validateBuildGraph({
      root: ROOT,
      releaseId: 'base',
      target: 'manifest',
      inputs: ['packages/releases/base/src/runtime.ts', 'packages/commerce/order/src/module.ts'],
      forbiddenSources: ['packages/commerce', 'packages/extensions'],
    })).toThrow('target "manifest" imports forbidden source "packages/commerce/order/src/module.ts"');
  });

  it('reuses an Admin bundle only when its release graph and output tree match provenance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-admin-provenance-'));
    const source = 'packages/releases/commerce/src/admin.tsx';
    const inputs = ['apps/admin/src/main.tsx', source, 'node_modules/.pnpm/react@19.0.0/node_modules/react/index.js'];
    const bundle = {
      'index.html': { type: 'asset' as const, source: '<main id="root"></main>' },
      'assets/admin.js': { type: 'chunk' as const, code: 'admin bundle', modules: { [source]: {}, 'apps/admin/src/main.tsx': {} } },
    };
    try {
      const provenance = createAdminProjectionProvenance({ root: ROOT, releaseId: 'commerce', source, inputs, bundle });
      mkdirSync(join(directory, 'assets'));
      writeFileSync(join(directory, 'index.html'), bundle['index.html'].source);
      writeFileSync(join(directory, 'assets/admin.js'), bundle['assets/admin.js'].code);
      writeFileSync(join(directory, ADMIN_PROJECTION_PROVENANCE), `${JSON.stringify(provenance)}\n`);

      expect(validateAdminProjectionProvenance({ root: ROOT, releaseId: 'commerce', source, directory }))
        .toMatchObject({ releaseId: 'commerce', target: 'admin', source, artifact: 'admin/index.html', status: 'built' });
      expect(() => validateAdminProjectionProvenance({ root: ROOT, releaseId: 'base', source, directory }))
        .toThrow('provenance does not match selected source');

      writeFileSync(join(directory, 'index.html'), '<main id="tampered"></main>');
      expect(() => validateAdminProjectionProvenance({ root: ROOT, releaseId: 'commerce', source, directory }))
        .toThrow('artifact tree differs from its provenance');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('emits native packaging data from the catalog without release-id branches in build scripts', () => {
    const basePlan = execFileSync(process.execPath, ['scripts/native-release-plan.mjs', 'base'], { cwd: ROOT })
      .toString('utf8').trimEnd().split('\n');
    expect(basePlan.slice(0, 4)).toEqual([
      'storeweave',
      'scripts/smoke-base.sh',
      'deployments/systemd/storeweave-api.service',
      'deployments/systemd/storeweave-worker.service',
    ]);
    const unsupported = spawnSync(process.execPath, ['scripts/native-release-plan.mjs', 'file-requests'], { cwd: ROOT, encoding: 'utf8' });
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain('Release "file-requests" has no native packaging plan');

    const plan = execFileSync(process.execPath, ['scripts/native-release-plan.mjs', 'commerce'], { cwd: ROOT })
      .toString('utf8').trimEnd().split('\n');
    expect(plan.slice(0, 4)).toEqual([
      'commerce',
      'scripts/smoke.sh',
      'deployments/systemd/commerce-api.service',
      'deployments/systemd/commerce-worker.service',
    ]);
    expect(plan.slice(5)).toEqual([
      'deployments/example-store/commerce.yaml', 'commerce.yaml.example',
      'deployments/example-store/commerce.env.example', 'commerce.env.example',
      'deployments/example-store-two/commerce.yaml', 'commerce.yaml.second-store-example',
    ]);

    for (const path of ['scripts/build.mjs', 'scripts/build-release.sh']) {
      const source = readFileSync(resolve(ROOT, path), 'utf8');
      expect(source, path).not.toMatch(/if\s*\(\s*releaseId\s*===|case\s+"\$RELEASE_ID"\s+in|\[\s*"\$RELEASE_ID"\s*=\s*(?:base|commerce)/);
    }
  });
});
