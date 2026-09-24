#!/usr/bin/env node
import { releases } from './releases.mjs';
// 把 TypeScript 原始碼打包成正式主機可直接執行的 JavaScript。
// 正式主機不需要 pnpm、TypeScript 或任何編譯工具。
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import {
  BUILD_TARGETS,
  ADMIN_PROJECTION_PROVENANCE,
  projectionAliases,
  projectionMetadata,
  resolveBuildProjections,
  resolveRuntimeProjectionSources,
  validateAdminProjectionProvenance,
  validateBuildGraph,
  validateProjectionGraph,
} from './build-projections.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const releaseId = process.env.STOREWEAVE_RELEASE ?? 'commerce';
if (!Object.hasOwn(releases, releaseId)) throw new Error(`Unknown release: ${releaseId}`);
const selected = releases[releaseId];
const skipAdmin = process.argv.includes('--skip-admin');
const projections = resolveBuildProjections({ root, releaseId, release: selected, skipAdmin });
const projectionByTarget = new Map(projections.map(projection => [projection.target, projection]));
const outDir = process.env.STOREWEAVE_BUILD_DIR ? resolve(process.env.STOREWEAVE_BUILD_DIR) : join(root, 'dist');
if (process.env.STOREWEAVE_BUILD_DIR && existsSync(outDir)) throw new Error('STOREWEAVE_BUILD_DIR must be a new directory');
const appDir = join(outDir, 'app');
const version = process.env.STOREWEAVE_RELEASE_VERSION ?? process.env.COMMERCE_RELEASE_VERSION ?? JSON.parse(
  execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: root, encoding: 'utf8' }),
).version;
const sourceRevision = process.env.STOREWEAVE_SOURCE_REVISION || undefined;
if (sourceRevision && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceRevision)) {
  throw new Error('STOREWEAVE_SOURCE_REVISION must be a 40- or 64-character lowercase hexadecimal object id');
}

const resolvedRuntime = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
  `const loaded = await import('./${selected.runtime}'); const release = loaded.release ?? loaded.default?.release; process.stdout.write(JSON.stringify({
    id: release.id,
    configKey: release.manifest.targets.config.key,
    storefrontKey: release.manifest.targets.storefront.key,
    configSource: release.configProjectionSource,
    storefrontSource: release.storefrontProjectionSource,
    configFilename: release.configProjection.defaultFilename,
    themeKeys: Object.keys(release.storefrontProjection.themes),
    themeAssets: release.storefrontProjection.themeAssets ?? null,
  }));`], { cwd: root, encoding: 'utf8' }));
if (resolvedRuntime.id !== releaseId) throw new Error(`Release "${releaseId}" target projections resolved runtime "${resolvedRuntime.id}"`);
const runtimeProjectionSources = resolveRuntimeProjectionSources({
  root,
  releaseId,
  release: selected,
  runtimeProjectionSources: { config: resolvedRuntime.configSource, storefront: resolvedRuntime.storefrontSource },
});
const runtimeProjectionMetadata = runtimeProjectionSources.map(projection => ({
  ...projection,
  key: projection.target === 'config' ? resolvedRuntime.configKey : resolvedRuntime.storefrontKey,
  artifact: null,
  status: 'resolved',
  value: projection.target === 'config'
    ? { defaultFilename: resolvedRuntime.configFilename }
    : { themeKeys: resolvedRuntime.themeKeys, themeAssets: resolvedRuntime.themeAssets },
}));

// NestJS 對這些套件都是「有裝才用」的 lazy require；我們沒有用到，因此標成 external。
// pg-native 是 pg 的選用原生加速套件，沒有它會自動走純 JS 路徑。
const EXTERNALS = [
  'pg-native',
  'class-transformer',
  'class-transformer/storage',
  'class-validator',
  'cache-manager',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/platform-express',
  '@fastify/view',
  '@fastify/middie',
  // Sharp resolves its native binding relative to its package at runtime; an
  // esbuild CJS bundle rewrites its import.meta based resolver and cannot load it.
  'sharp',
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

const entries = [
  ...BUILD_TARGETS.filter(target => target.target !== 'admin').map(target => ({
    target: target.target,
    in: join(root, target.entry),
    out: join(outDir, target.artifact),
  })),
  { in: join(root, 'scripts/seed.ts'), out: join(appDir, 'seed.js'), target: 'seed' },
];
const manifestEntry = { in: join(root, 'scripts/release-manifest.ts'), out: join(outDir, 'release-manifest.js') };
const validatorEntry = { in: join(root, 'scripts/validate-release.ts'), out: join(outDir, 'scripts/validate-release.js') };
let manifestChecksum;
const projectionMetadataByTarget = new Map();

for (const entry of [manifestEntry, ...entries, validatorEntry]) {
  const projection = projectionByTarget.get(entry.target);
  const aliases = projection
    ? projectionAliases(root, releaseId, selected, projection.target)
    : { '@storeweave/selected-runtime': join(root, selected.runtime) };
  if (entry.target === 'seed') aliases['@storeweave/selected-seed'] = join(root, selected.seed);
  let result;
  try {
    result = await build({
      entryPoints: [entry.in],
      outfile: entry.out,
      bundle: true,
      metafile: true,
      define: {
        'process.env.STOREWEAVE_RELEASE_VERSION': JSON.stringify(version),
        ...(manifestChecksum ? { 'process.env.STOREWEAVE_BUILD_MANIFEST_SHA': JSON.stringify(manifestChecksum) } : {}),
      },
      alias: aliases,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      sourcemap: true,
      minify: false,
      tsconfig: join(root, 'tsconfig.json'),
      // pg-native 是 pg 的選用原生加速套件；沒有它 pg 會自動走純 JS 路徑
      external: EXTERNALS,
      banner: { js: `// StoreWeave ${version} — generated by scripts/build.mjs, do not edit` },
      logLevel: 'info',
    });
  } catch (error) {
    if (!entry.target) throw error;
    const target = projection?.target ?? entry.target;
    const source = projection?.source ?? entry.in.replace(`${root}/`, '');
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Release "${releaseId}" target "${target}" could not resolve source "${source}": ${detail}`, { cause: error });
  }
  const inputs = Object.keys(result.metafile.inputs);
  if (projection) {
    projectionMetadataByTarget.set(projection.target, validateProjectionGraph({
      root,
      releaseId,
      target: projection.target,
      source: projection.source,
      artifact: projection.artifact,
      inputs,
      forbiddenSources: selected.forbiddenInputs ?? [],
    }));
  } else {
    validateBuildGraph({ root, releaseId, target: entry.target ?? 'manifest', inputs, forbiddenSources: selected.forbiddenInputs ?? [] });
  }
  writeFileSync(`${entry.out}.meta.json`, `${JSON.stringify(result.metafile, null, 2)}\n`);
  if (entry === manifestEntry) {
    // An artifact may be built outside the repository (release validation does
    // this). External native modules such as Sharp still resolve from the
    // workspace install while its manifest entrypoint is evaluated.
    const result = JSON.parse(execFileSync(process.execPath, [entry.out], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_PATH: join(root, 'node_modules') } }));
    manifestChecksum = result.checksum;
    writeFileSync(join(outDir, 'release-manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`);
    rmSync(entry.out);
    rmSync(`${entry.out}.map`);
  }

}

const adminEntry = join(root, 'apps/admin/index.html');
const adminProjection = projectionByTarget.get('admin');
if (adminProjection.status === 'built') {
  if (!existsSync(adminEntry)) throw new Error(`Release "${releaseId}" target "admin" entry is missing: "apps/admin/index.html"`);
  let result;
  try {
    result = await viteBuild({
      configFile: join(root, 'apps/admin/vite.config.ts'),
      logLevel: 'info',
      build: { outDir: join(outDir, 'admin'), emptyOutDir: true },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Release "${releaseId}" target "admin" could not resolve projection source "${adminProjection.source}": ${detail}`, { cause: error });
  }
  const outputs = Array.isArray(result) ? result : [result];
  const inputs = new Set();
  for (const output of outputs) {
    if (!('output' in output)) throw new Error(`Release "${releaseId}" target "admin" unexpectedly entered watch mode`);
    for (const chunk of output.output) {
      if (chunk.type !== 'chunk') continue;
      for (const input of Object.keys(chunk.modules)) inputs.add(input);
    }
  }
  projectionMetadataByTarget.set('admin', validateProjectionGraph({
    root,
    releaseId,
    target: 'admin',
    source: adminProjection.source,
    artifact: adminProjection.artifact,
    inputs: [...inputs],
    forbiddenSources: selected.forbiddenInputs ?? [],
  }));
  rmSync(join(outDir, 'admin', ADMIN_PROJECTION_PROVENANCE), { force: true });
} else if (adminProjection.enabled && skipAdmin) {
  const explicitReuseDir = Boolean(process.env.STOREWEAVE_ADMIN_CACHE_DIR);
  const reuseDir = explicitReuseDir
    ? resolve(process.env.STOREWEAVE_ADMIN_CACHE_DIR)
    : join(root, 'apps/admin/dist');
  if (explicitReuseDir && !existsSync(reuseDir)) {
    throw new Error(`Release "${releaseId}" target "admin" reuse directory does not exist: "${reuseDir}"`);
  }
  if (existsSync(reuseDir)) {
    validateAdminProjectionProvenance({
      root,
      releaseId,
      source: adminProjection.source,
      directory: reuseDir,
      forbiddenSources: selected.forbiddenInputs ?? [],
    });
    cpSync(reuseDir, join(outDir, 'admin'), { recursive: true });
    const reusedProjection = validateAdminProjectionProvenance({
      root,
      releaseId,
      source: adminProjection.source,
      directory: join(outDir, 'admin'),
      forbiddenSources: selected.forbiddenInputs ?? [],
    });
    rmSync(join(outDir, 'admin', ADMIN_PROJECTION_PROVENANCE), { force: true });
    projectionMetadataByTarget.set('admin', reusedProjection);
  } else {
    projectionMetadataByTarget.set('admin', projectionMetadata({
      releaseId,
      target: 'admin',
      source: adminProjection.source,
      artifact: adminProjection.artifact,
      status: 'skipped',
    }));
  }
} else {
  projectionMetadataByTarget.set('admin', projectionMetadata({
    releaseId,
    target: 'admin',
    source: adminProjection.source,
    artifact: adminProjection.artifact,
    status: adminProjection.status,
  }));
}

// Default Theme editorial media is a release-owned asset set. It is copied
// separately from the bundled JS so the storefront can serve it with ordinary
// HTTP caching rather than encoding image bytes into each SSR response.
const defaultThemeAssets = resolvedRuntime.themeAssets && resolve(root, resolvedRuntime.themeAssets);
if (defaultThemeAssets && !defaultThemeAssets.startsWith(`${root}/`)) {
  throw new Error(`Release "${releaseId}" storefront projection theme assets escape the repository: "${resolvedRuntime.themeAssets}"`);
}
if (defaultThemeAssets) {
  if (!existsSync(defaultThemeAssets)) throw new Error(`Release "${releaseId}" storefront projection theme assets are missing: "${resolvedRuntime.themeAssets}"`);
  cpSync(defaultThemeAssets, join(outDir, 'theme-assets'), { recursive: true });
}

writeFileSync(join(outDir, 'VERSION'), `${version}\n`, 'utf8');
writeFileSync(
  join(outDir, 'build-info.json'),
  `${JSON.stringify({
    releaseId,
    version,
    manifestChecksum,
    ...(sourceRevision ? { sourceRevision } : {}),
    builtOnNode: process.version,
    entries: entries.map((e) => e.out.replace(root, '')),
    projections: BUILD_TARGETS.map(({ target }) => projectionMetadataByTarget.get(target)),
    runtimeProjections: runtimeProjectionMetadata,
    storefront: { themeKeys: resolvedRuntime.themeKeys, themeAssets: resolvedRuntime.themeAssets },
  }, null, 2)}\n`,
  'utf8',
);

console.log(`\nbuilt ${version} -> ${outDir}`);
