import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { releases } from '../../scripts/releases.mjs';
import { ADMIN_PROJECTION_PROVENANCE, createAdminProjectionProvenance } from '../../scripts/build-projections.mjs';

const rootDir = import.meta.dirname;
const workspaceRoot = resolve(rootDir, '../..');
const releaseId = process.env.STOREWEAVE_RELEASE ?? 'commerce';
const selected = releases[releaseId];
if (!selected || selected.admin !== true || typeof selected.adminProjection !== 'string' || selected.adminProjection.trim() === '') {
  throw new Error(`Release "${releaseId}" does not select an Admin target projection`);
}
const selectedAdminProjection = resolve(workspaceRoot, selected.adminProjection);

const projectionProvenancePlugin: Plugin = {
  name: 'storeweave-admin-projection-provenance',
  generateBundle: {
    order: 'post',
    handler(_options, bundle) {
    const inputs = Object.values(bundle).flatMap(output => output.type === 'chunk' ? Object.keys(output.modules ?? {}) : []);
    const provenance = createAdminProjectionProvenance({
      root: workspaceRoot,
      releaseId,
      source: selected.adminProjection,
      inputs,
      bundle,
    });
    this.emitFile({
      type: 'asset',
      fileName: ADMIN_PROJECTION_PROVENANCE,
      source: `${JSON.stringify(provenance, null, 2)}\n`,
    });
    },
  },
};

// Run the same selected module that Vite aliases before Rollup starts building.
execFileSync('pnpm', [
  'exec', 'tsx', 'scripts/validate-admin-projection.ts',
  selectedAdminProjection, releaseId, resolve(workspaceRoot, selected.runtime),
], {
  cwd: workspaceRoot,
  stdio: 'inherit',
});

export default defineConfig({
  root: resolve(rootDir),
  base: '/admin/',
  plugins: [react(), projectionProvenancePlugin],
  resolve: {
    // 後台是獨立的 vite build，不吃根 tsconfig 的 paths。共用套件要在這裡對應到
    // 原始碼，否則只有型別解析得到，實際 bundle 會找不到模組。
    alias: {
      '@storeweave/i18n': resolve(rootDir, '../../packages/platform/i18n/src/index.ts'),
      '@storeweave/contracts': resolve(rootDir, '../../packages/platform/contracts/src/index.ts'),
      '@storeweave/release/admin': resolve(rootDir, '../../packages/platform/release/src/admin.ts'),
      '@storeweave/release': resolve(rootDir, '../../packages/platform/release/src/index.ts'),
      '@storeweave/selected-admin': selectedAdminProjection,
    },
  },
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
