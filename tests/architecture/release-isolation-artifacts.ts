import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { noopLogger } from '@storeweave/contracts';
import { ProviderRegistry } from '@storeweave/extension-sdk';
// @ts-expect-error no TypeScript declaration for the build-only selector
import { releases } from '../../scripts/releases.mjs';
import type { ModulePin, ReleaseId, SourceText, Target, TargetGraph } from './release-isolation-rules';

export const ROOT = resolve(__dirname, '..', '..');

const NODE_TARGETS = ['server', 'worker', 'cli'] as const;
const NODE_ENTRY: Record<(typeof NODE_TARGETS)[number], string> = {
  server: 'apps/api/src/main.ts',
  worker: 'apps/worker/src/main.ts',
  cli: 'tools/cli/src/main.ts',
};
const NODE_ALIAS: Record<(typeof NODE_TARGETS)[number], string> = {
  server: '@storeweave/selected-server',
  worker: '@storeweave/selected-worker',
  cli: '@storeweave/selected-cli',
};

/** In-process esbuild bundle graph — same pattern as cli-projection-imports.test.ts. */
async function bundleGraph(releaseId: ReleaseId, target: Target, entry: string, alias: Record<string, string>): Promise<TargetGraph> {
  const result = await esbuild({
    entryPoints: [resolve(ROOT, entry)],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    tsconfig: resolve(ROOT, 'tsconfig.json'),
    external: ['pg-native', 'class-transformer', 'class-transformer/storage', 'class-validator', 'cache-manager',
      '@nestjs/websockets', '@nestjs/websockets/socket-module', '@nestjs/microservices', '@nestjs/microservices/microservices-module',
      '@nestjs/platform-express', '@fastify/view', '@fastify/middie', 'sharp'],
    alias,
    logLevel: 'silent',
  });
  return { releaseId, target, artifact: entry, inputs: Object.keys(result.metafile!.inputs) };
}

/** A release's server/worker/cli node targets, real esbuild graphs (no files written to disk). */
export async function buildNodeGraphs(releaseId: ReleaseId): Promise<Record<(typeof NODE_TARGETS)[number], TargetGraph>> {
  const selected = releases[releaseId];
  const entries = await Promise.all(NODE_TARGETS.map(target => bundleGraph(releaseId, target, NODE_ENTRY[target], {
    '@storeweave/selected-runtime': resolve(ROOT, selected.runtime),
    [NODE_ALIAS[target]]: resolve(ROOT, selected[target]),
  })));
  return Object.fromEntries(NODE_TARGETS.map((target, index) => [target, entries[index]])) as Record<(typeof NODE_TARGETS)[number], TargetGraph>;
}

/** The seed target: bundles scripts/seed.ts with the release's runtime + seed selection. */
export async function buildSeedGraph(releaseId: ReleaseId): Promise<TargetGraph> {
  const selected = releases[releaseId];
  return bundleGraph(releaseId, 'seed', 'scripts/seed.ts', {
    '@storeweave/selected-runtime': resolve(ROOT, selected.runtime),
    '@storeweave/selected-seed': resolve(ROOT, selected.seed),
  });
}

/**
 * The Admin (browser) graph via an in-process Vite build with `write:false` — same
 * pattern already used by admin-projection-artifact.test.ts / booking-admin-projection.test.ts.
 * Vite reads `STOREWEAVE_RELEASE` from `process.env` at config-load time; since the `unit`
 * project runs on the `threads` pool, callers must not run two of these concurrently.
 */
export async function buildAdminGraph(releaseId: ReleaseId): Promise<TargetGraph> {
  const previous = process.env.STOREWEAVE_RELEASE;
  process.env.STOREWEAVE_RELEASE = releaseId;
  try {
    const result = await viteBuild({ configFile: resolve(ROOT, 'apps/admin/vite.config.ts'), logLevel: 'silent', build: { write: false, emptyOutDir: false } });
    const outputs = Array.isArray(result) ? result : [result];
    const inputs = new Set<string>();
    for (const output of outputs) {
      if (!('output' in output)) throw new Error(`Release "${releaseId}" Admin build unexpectedly entered watch mode`);
      for (const chunk of output.output) {
        if (chunk.type !== 'chunk') continue;
        for (const input of Object.keys(chunk.modules)) inputs.add(input);
      }
    }
    return { releaseId, target: 'admin', artifact: 'admin/index.html', inputs: [...inputs] };
  } finally {
    if (previous === undefined) delete process.env.STOREWEAVE_RELEASE;
    else process.env.STOREWEAVE_RELEASE = previous;
  }
}

/** R4 — the release root's own import graph (`packages/releases/<id>/src/index.ts`). */
export async function buildRootEntryGraph(releaseId: ReleaseId): Promise<TargetGraph> {
  const entry = `packages/releases/${releaseId}/src/index.ts`;
  const result = await esbuild({
    entryPoints: [resolve(ROOT, entry)],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    tsconfig: resolve(ROOT, 'tsconfig.json'),
    external: ['pg-native'],
    logLevel: 'silent',
  });
  return { releaseId, target: 'root', artifact: entry, inputs: Object.keys(result.metafile!.inputs) };
}

interface RawModule {
  readonly name: string;
  readonly migrations?: { readonly module: string; readonly migrations: readonly { readonly id: string; readonly up: string }[] };
  readonly data?: { readonly owns?: readonly string[] };
}

/** Runs a release's `createModules` the same way `buildReleaseManifest` does — declarations only, no DB. */
async function createRawModules(releaseId: ReleaseId): Promise<readonly RawModule[]> {
  const { release } = await import(`../../packages/releases/${releaseId}/src/runtime`);
  const config = release.config.schema.parse(release.manifestConfig);
  return release.createModules({ config, providers: new ProviderRegistry(noopLogger) });
}

/** R1 schema — `buildReleaseManifest` projection (`modules[].{migrationOwner,dataRelations,migrations}`), no DB. */
export async function collectReleaseManifest(releaseId: ReleaseId): Promise<{ modules: readonly ModulePin[] }> {
  const { release } = await import(`../../packages/releases/${releaseId}/src/runtime`);
  const { buildReleaseManifest } = await import('../../packages/platform/release/src/runtime');
  const manifest = buildReleaseManifest(release);
  return { modules: manifest.modules.map((module: { id: string; migrationOwner: string | null; dataRelations: readonly string[]; migrations: readonly { id: string }[] }) => ({
    id: module.id, migrationOwner: module.migrationOwner, dataRelations: module.dataRelations, migrations: module.migrations,
  })) };
}

const CREATE_RELATION = /CREATE\s+(?:UNLOGGED\s+)?(?:TABLE|SEQUENCE)\s+(?:IF NOT EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/** SQL cross-check for R1: every relation a Booking migration's `up` SQL actually creates. */
export async function collectSqlRelations(releaseId: ReleaseId): Promise<{ module: string; migration: string; relation: string }[]> {
  const modules = await createRawModules(releaseId);
  const relations: { module: string; migration: string; relation: string }[] = [];
  for (const module of modules) {
    if (!module.migrations) continue;
    for (const migration of module.migrations.migrations) {
      for (const match of migration.up.matchAll(CREATE_RELATION)) {
        relations.push({ module: module.migrations.module, migration: migration.id, relation: match[1]! });
      }
    }
  }
  return relations;
}

// ---------------------------------------------------------------------------
// R3 — common assembly source scan
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(?:ts|tsx|mjs)$/.test(entry) && !entry.endsWith('.d.ts') && !/\.test\.[jt]sx?$/.test(entry) && !full.replaceAll('\\', '/').includes('/test/')) out.push(full);
  }
}

/**
 * R3 scope: Platform/Base common assembly, host apps' non-release-specific source, build
 * scripts, and `tools/cli` (SW-144 decision: R3 scan includes tools/cli; its 5 pinned
 * product-id branches are a known-exception list citing GitHub issue #97, not a skip).
 */
export function commonAssemblyFiles(): SourceText[] {
  const dirs = [
    'packages/platform', 'packages/releases/base', 'packages/themes/base',
    'apps/api/src', 'apps/worker/src', 'apps/admin/src', 'tools/cli/src',
  ];
  const excluded = [
    /(?:^|\/)apps\/api\/src\/releases\//,
    /(?:^|\/)apps\/api\/src\/controllers\/booking-/,
    /(?:^|\/)apps\/worker\/src\/releases\//,
  ];
  const files: string[] = [];
  for (const dir of dirs) walk(resolve(ROOT, dir), files);
  const extraScripts = ['scripts/build.mjs', 'scripts/build-projections.mjs', 'scripts/release-manifest.ts', 'scripts/validate-release.ts', 'apps/admin/vite.config.ts']
    .map(path => resolve(ROOT, path));
  return [...files, ...extraScripts]
    .map(absolute => relative(ROOT, absolute).replaceAll('\\', '/'))
    .filter(path => !excluded.some(pattern => pattern.test(path)))
    .map(path => ({ path, text: readFileSync(resolve(ROOT, path), 'utf8') }));
}
