import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { build as viteBuild } from 'vite';
import { catalogDigest } from '@storeweave/db';

const ROOT = resolve(__dirname, '..', '..');
const FIXED_VERSION = '0.1.0-sw102';
type ReleaseSelection = { runtime: string; http: string; seed: string; admin: boolean; themeAssets: string | null };
const PUBLIC_CONTRACT_INPUTS = [
  'docs/base/b17/b00-catalog.json',
  'docs/base/b17/commerce-http-contract.v1.json',
  'docs/base/b17/commerce-public-contract.structural.v1.json',
  'docs/base/b17/commerce-public-contract.semantic.v2.json',
] as const;

type Target = { status: 'present'; inputCount: number; inputsChecksum: string } | { status: 'absent' };
type PublicContract = { status: 'present'; inputs: { path: string; sha256: string }[] } | { status: 'absent' };
export interface ReleaseBaseline {
  format: 'storeweave.release-baseline.v1';
  deterministicInputs: { releaseVersion: string; releaseCatalog: string; targets: Record<'server' | 'worker' | 'cli' | 'admin', string | null> };
  releases: Record<'base' | 'commerce', {
    identity: { id: string; version: string; manifestChecksum: string };
    selected: ReleaseSelection;
    targets: Record<'server' | 'worker' | 'cli' | 'admin', Target>;
    publicContract: PublicContract;
  }>;
}

function sha256(file: string) {
  return createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex');
}

function sourcePath(file: string) {
  const value = relative(ROOT, resolve(ROOT, file)).replaceAll('\\', '/');
  if (value.startsWith('../')) throw new Error(`Release baseline input escapes repository: ${file}`);
  return value;
}

function projectMetafile(file: string): Target {
  if (!existsSync(file)) throw new Error(`Release baseline target artifact is missing: ${file}`);
  const metafile = JSON.parse(readFileSync(file, 'utf8')) as { inputs: Record<string, unknown> };
  const inputs = Object.keys(metafile.inputs)
    .map(sourcePath)
    .filter(input => /^(apps|packages|scripts|tools)\//.test(input))
    .sort();
  return { status: 'present', inputCount: inputs.length, inputsChecksum: catalogDigest(inputs) };
}

function projectSelections(): Record<'base' | 'commerce', ReleaseSelection> {
  const result = execFileSync(process.execPath, ['--input-type=module', '--eval',
    "import { releases } from './scripts/releases.mjs'; process.stdout.write(JSON.stringify(releases))"], { cwd: ROOT, encoding: 'utf8' });
  const catalog = JSON.parse(result) as Record<string, Partial<ReleaseSelection>>;
  return Object.fromEntries((['base', 'commerce'] as const).map(id => {
    const release = catalog[id];
    if (!release || typeof release.runtime !== 'string' || typeof release.http !== 'string' || typeof release.seed !== 'string' || typeof release.admin !== 'boolean') {
      throw new Error(`Release baseline selection is invalid: ${id}`);
    }
    return [id, { runtime: release.runtime, http: release.http, seed: release.seed, admin: release.admin, themeAssets: release.themeAssets ?? null }];
  })) as Record<'base' | 'commerce', ReleaseSelection>;
}

function projectIdentity(releaseId: 'base' | 'commerce', output: string): ReleaseBaseline['releases']['base']['identity'] {
  const info = JSON.parse(readFileSync(join(output, 'build-info.json'), 'utf8')) as { releaseId?: string; version?: string; manifestChecksum?: string };
  const manifest = JSON.parse(readFileSync(join(output, 'release-manifest.json'), 'utf8')) as { releaseId?: string; releaseVersion?: string };
  const checksum = catalogDigest(manifest);
  if (info.releaseId !== releaseId || manifest.releaseId !== releaseId || typeof info.version !== 'string' || manifest.releaseVersion !== info.version || info.manifestChecksum !== checksum) {
    throw new Error(`Release baseline ${releaseId}/manifest identity does not match its built artifact`);
  }
  return { id: releaseId, version: info.version, manifestChecksum: checksum };
}

async function projectAdmin(releaseId: 'base' | 'commerce', selection: ReleaseSelection, output: string): Promise<Target> {
  const artifact = join(output, 'admin', 'index.html');
  if (!selection.admin) {
    if (existsSync(artifact)) throw new Error(`Release baseline ${releaseId}/admin target is unexpectedly present`);
    return { status: 'absent' };
  }
  if (!existsSync(artifact)) throw new Error(`Release baseline ${releaseId}/admin target artifact is missing`);
  const viteOutput = await viteBuild({
    configFile: join(ROOT, 'apps/admin/vite.config.ts'),
    build: { write: false, emptyOutDir: false },
    logLevel: 'silent',
  });
  const results = Array.isArray(viteOutput) ? viteOutput : [viteOutput];
  const inputs = new Set<string>();
  for (const result of results) {
    if (!('output' in result)) throw new Error('Release baseline admin build unexpectedly entered watch mode');
    for (const chunk of result.output) {
      if (chunk.type !== 'chunk') continue;
      for (const moduleId of Object.keys(chunk.modules)) {
        const input = sourcePath(moduleId);
        if (/^(apps|packages|scripts|tools)\//.test(input)) inputs.add(input);
      }
    }
  }
  const graph = [...inputs].sort();
  return { status: 'present', inputCount: graph.length, inputsChecksum: catalogDigest(graph) };
}

function projectPublicContract(releaseId: 'base' | 'commerce'): PublicContract {
  if (releaseId === 'base') return { status: 'absent' };
  return { status: 'present', inputs: PUBLIC_CONTRACT_INPUTS.map(path => ({ path, sha256: sha256(path) })) };
}

function build(releaseId: 'base' | 'commerce', root: string) {
  const output = join(root, releaseId);
  execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: ROOT,
    env: { ...process.env, STOREWEAVE_RELEASE: releaseId, STOREWEAVE_RELEASE_VERSION: FIXED_VERSION, STOREWEAVE_BUILD_DIR: output },
    stdio: 'pipe',
  });
  return output;
}

export async function projectReleaseBaseline(parent = mkdtempSync(join(tmpdir(), 'storeweave-release-baseline-'))): Promise<ReleaseBaseline> {
  const ownParent = !existsSync(parent) || parent.startsWith(tmpdir());
  try {
    const baseOutput = build('base', parent);
    const commerceOutput = build('commerce', parent);
    const selections = projectSelections();
    const project = async (releaseId: 'base' | 'commerce', output: string, identity: ReleaseBaseline['releases']['base']['identity']) => ({
      identity,
      selected: selections[releaseId],
      targets: {
        server: projectMetafile(join(output, 'app/api.js.meta.json')),
        worker: projectMetafile(join(output, 'app/worker.js.meta.json')),
        cli: projectMetafile(join(output, 'app/cli.js.meta.json')),
        admin: await projectAdmin(releaseId, selections[releaseId], output),
      },
      publicContract: projectPublicContract(releaseId),
    });
    return {
      format: 'storeweave.release-baseline.v1',
      deterministicInputs: {
        releaseVersion: FIXED_VERSION, releaseCatalog: 'scripts/releases.mjs',
        targets: { server: 'apps/api/src/main.ts', worker: 'apps/worker/src/main.ts', cli: 'tools/cli/src/main.ts', admin: 'apps/admin/index.html' },
      },
      releases: {
        base: await project('base', baseOutput, projectIdentity('base', baseOutput)),
        commerce: await project('commerce', commerceOutput, projectIdentity('commerce', commerceOutput)),
      },
    };
  } finally {
    if (ownParent) rmSync(parent, { recursive: true, force: true });
  }
}

export function readExpectedBaseline(): ReleaseBaseline {
  return JSON.parse(readFileSync(join(ROOT, 'tests/architecture/fixtures/sw-102-release-baseline.v1.json'), 'utf8')) as ReleaseBaseline;
}

export function assertReleaseBaseline(actual: ReleaseBaseline, expected: ReleaseBaseline) {
  for (const releaseId of ['base', 'commerce'] as const) {
    for (const target of ['server', 'worker', 'cli', 'admin'] as const) {
      if (expected.releases[releaseId].targets[target].status !== actual.releases[releaseId].targets[target].status) {
        throw new Error(`Release baseline ${releaseId}/${target} target is missing or unexpectedly present`);
      }
      if (JSON.stringify(expected.releases[releaseId].targets[target]) !== JSON.stringify(actual.releases[releaseId].targets[target])) {
        throw new Error(`Release baseline ${releaseId}/${target} target import graph differs from checked-in baseline`);
      }
    }
    if (JSON.stringify(actual.releases[releaseId].publicContract) !== JSON.stringify(expected.releases[releaseId].publicContract)) {
      throw new Error(`Release baseline ${releaseId}/public-contract differs from checked-in baseline`);
    }
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Release baseline differs from checked-in baseline');
}
