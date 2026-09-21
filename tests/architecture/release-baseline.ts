import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { catalogDigest } from '@storeweave/db';

const ROOT = resolve(__dirname, '..', '..');
const FIXED_VERSION = '0.1.0-sw102';
type ReleaseSelection = { runtime: string; server: string; worker: string; adminProjection: string; cli: string; configProjection: string; storefrontProjection: string; seed: string; admin: boolean };
const PUBLIC_CONTRACT_INPUTS = [
  'docs/base/b17/b00-catalog.json',
  'docs/base/b17/commerce-http-contract.v1.json',
  'docs/base/b17/commerce-public-contract.structural.v1.json',
  'docs/base/b17/commerce-public-contract.semantic.v2.json',
] as const;

type Target = { status: 'present'; inputCount: number; inputsChecksum: string } | { status: 'absent' };
type ReleaseTarget = 'server' | 'worker' | 'admin' | 'cli';
type ProjectionMetadata = {
  releaseId: string;
  target: ReleaseTarget;
  source: string;
  artifact: string | null;
  status: 'built' | 'disabled' | 'skipped';
  inputCount: number;
  inputsChecksum: string | null;
};
type RuntimeProjectionMetadata = {
  releaseId: string;
  target: 'config' | 'storefront';
  source: string;
  key: string;
  artifact: null;
  status: 'resolved';
  value: Record<string, unknown>;
};
type PublicContract = { status: 'present'; inputs: { path: string; sha256: string }[] } | { status: 'absent' };
export interface ReleaseBaseline {
  format: 'storeweave.release-baseline.v1';
  deterministicInputs: { releaseVersion: string; releaseCatalog: string; targets: Record<'server' | 'worker' | 'cli' | 'admin', string | null> };
  releases: Record<'base' | 'commerce', {
    identity: { id: string; version: string; manifestChecksum: string };
    selected: ReleaseSelection;
    targets: Record<ReleaseTarget, Target>;
    projections: Record<ReleaseTarget, ProjectionMetadata>;
    runtimeProjections: Record<'config' | 'storefront', RuntimeProjectionMetadata>;
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
    if (!release || typeof release.runtime !== 'string' || typeof release.server !== 'string' || typeof release.worker !== 'string' || typeof release.adminProjection !== 'string' || typeof release.cli !== 'string' || typeof release.configProjection !== 'string' || typeof release.storefrontProjection !== 'string' || typeof release.seed !== 'string' || typeof release.admin !== 'boolean') {
      throw new Error(`Release baseline selection is invalid: ${id}`);
    }
    return [id, { runtime: release.runtime, server: release.server, worker: release.worker, adminProjection: release.adminProjection, cli: release.cli, configProjection: release.configProjection, storefrontProjection: release.storefrontProjection, seed: release.seed, admin: release.admin }];
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

function projectAdmin(releaseId: 'base' | 'commerce', selection: ReleaseSelection, output: string): Target {
  const artifact = join(output, 'admin', 'index.html');
  if (!existsSync(join(ROOT, selection.adminProjection))) throw new Error(`Release baseline ${releaseId}/admin projection is missing`);
  const projection = readProjections(output).admin;
  if (!projection) throw new Error(`Release baseline ${releaseId}/admin projection metadata is missing`);
  if (!selection.admin) {
    if (existsSync(artifact)) throw new Error(`Release baseline ${releaseId}/admin target is unexpectedly present`);
    if (projection.status !== 'disabled') throw new Error(`Release baseline ${releaseId}/admin target is not marked disabled`);
    return { status: 'absent' };
  }
  if (!existsSync(artifact)) throw new Error(`Release baseline ${releaseId}/admin target artifact is missing`);
  if (projection.status !== 'built' || !projection.inputsChecksum) {
    throw new Error(`Release baseline ${releaseId}/admin target is not marked built`);
  }
  return { status: 'present', inputCount: projection.inputCount, inputsChecksum: projection.inputsChecksum };
}

function readProjections(output: string): Record<ReleaseTarget, ProjectionMetadata> {
  const buildInfo = JSON.parse(readFileSync(join(output, 'build-info.json'), 'utf8')) as { projections?: ProjectionMetadata[] };
  if (!buildInfo.projections || buildInfo.projections.length !== 4) throw new Error('Release baseline projection metadata is incomplete');
  return Object.fromEntries(buildInfo.projections.map(projection => [projection.target, projection])) as Record<ReleaseTarget, ProjectionMetadata>;
}

function projectProjections(
  releaseId: 'base' | 'commerce',
  selection: ReleaseSelection,
  output: string,
  targets: Record<ReleaseTarget, Target>,
): Record<ReleaseTarget, ProjectionMetadata> {
  const projections = readProjections(output);
  const sources: Record<ReleaseTarget, string> = {
    server: selection.server,
    worker: selection.worker,
    admin: selection.adminProjection,
    cli: selection.cli,
  };
  const artifacts: Record<ReleaseTarget, string> = {
    server: 'app/api.js',
    worker: 'app/worker.js',
    admin: 'admin/index.html',
    cli: 'app/cli.js',
  };
  for (const target of ['server', 'worker', 'admin', 'cli'] as const) {
    const projection = projections[target];
    if (!projection || projection.releaseId !== releaseId || projection.target !== target || projection.source !== sources[target]) {
      throw new Error(`Release baseline ${releaseId}/${target} projection metadata does not match its selected source`);
    }
    const expectedStatus = target === 'admin' && !selection.admin ? 'disabled' : 'built';
    const expectedArtifact = expectedStatus === 'built' ? artifacts[target] : null;
    if (projection.status !== expectedStatus || projection.artifact !== expectedArtifact) {
      throw new Error(`Release baseline ${releaseId}/${target} projection metadata has the wrong artifact status`);
    }
    const graph = targets[target];
    if (expectedStatus === 'built') {
      if (graph.status !== 'present' || projection.inputCount !== graph.inputCount || projection.inputsChecksum !== graph.inputsChecksum) {
        throw new Error(`Release baseline ${releaseId}/${target} projection metadata differs from its artifact graph`);
      }
    } else if (graph.status !== 'absent' || projection.inputCount !== 0 || projection.inputsChecksum !== null) {
      throw new Error(`Release baseline ${releaseId}/${target} disabled projection emitted an artifact graph`);
    }
  }
  return projections;
}

function projectRuntimeProjections(releaseId: 'base' | 'commerce', selection: ReleaseSelection, output: string): Record<'config' | 'storefront', RuntimeProjectionMetadata> {
  const buildInfo = JSON.parse(readFileSync(join(output, 'build-info.json'), 'utf8')) as { runtimeProjections?: RuntimeProjectionMetadata[] };
  if (!buildInfo.runtimeProjections || buildInfo.runtimeProjections.length !== 2) {
    throw new Error(`Release baseline ${releaseId} runtime projection metadata is incomplete`);
  }
  const projections = Object.fromEntries(buildInfo.runtimeProjections.map(projection => [projection.target, projection])) as Record<'config' | 'storefront', RuntimeProjectionMetadata>;
  const sources = { config: selection.configProjection, storefront: selection.storefrontProjection };
  for (const target of ['config', 'storefront'] as const) {
    const projection = projections[target];
    if (!projection || projection.releaseId !== releaseId || projection.target !== target || projection.source !== sources[target]
      || !projection.key || projection.status !== 'resolved' || projection.artifact !== null || !projection.value) {
      throw new Error(`Release baseline ${releaseId}/${target} runtime projection metadata does not match its resolved source`);
    }
  }
  return projections;
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
    const project = (releaseId: 'base' | 'commerce', output: string, identity: ReleaseBaseline['releases']['base']['identity']) => {
      const targets: Record<ReleaseTarget, Target> = {
        server: projectMetafile(join(output, 'app/api.js.meta.json')),
        worker: projectMetafile(join(output, 'app/worker.js.meta.json')),
        cli: projectMetafile(join(output, 'app/cli.js.meta.json')),
        admin: projectAdmin(releaseId, selections[releaseId], output),
      };
      return {
        identity,
        selected: selections[releaseId],
        targets,
        projections: projectProjections(releaseId, selections[releaseId], output, targets),
        runtimeProjections: projectRuntimeProjections(releaseId, selections[releaseId], output),
        publicContract: projectPublicContract(releaseId),
      };
    };
    return {
      format: 'storeweave.release-baseline.v1',
      deterministicInputs: {
        releaseVersion: FIXED_VERSION, releaseCatalog: 'scripts/releases.mjs',
        targets: { server: 'apps/api/src/main.ts', worker: 'apps/worker/src/main.ts', cli: 'tools/cli/src/main.ts', admin: 'apps/admin/index.html' },
      },
      releases: {
        base: project('base', baseOutput, projectIdentity('base', baseOutput)),
        commerce: project('commerce', commerceOutput, projectIdentity('commerce', commerceOutput)),
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
