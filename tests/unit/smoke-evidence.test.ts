import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogDigest } from '@storeweave/db';

const directories: string[] = [];
const script = join(process.cwd(), 'scripts/record-smoke-evidence.mjs');
const nativeSmokeScript = join(process.cwd(), 'scripts/smoke-native.sh');

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-smoke-evidence-'));
  directories.push(directory);
  const manifest = { schemaVersion: 1, releaseId: 'commerce', releaseVersion: '1.2.3', modules: [{ id: 'platform', version: '1.0.0' }] };
  const buildInfo = { releaseId: 'commerce', version: '1.2.3', manifestChecksum: catalogDigest(manifest), sourceRevision: 'a'.repeat(40) };
  const paths = { buildInfo: join(directory, 'build-info.json'), manifest: join(directory, 'release-manifest.json'), output: join(directory, 'evidence.json'), artifact: join(directory, 'release.tar.gz') };
  writeFileSync(paths.buildInfo, JSON.stringify(buildInfo));
  writeFileSync(paths.manifest, JSON.stringify(manifest));
  writeFileSync(paths.artifact, 'native artifact');
  return { directory, manifest, buildInfo, paths };
}

function run(args: string[]) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function common(paths: ReturnType<typeof fixture>['paths']) {
  return ['--release', 'commerce', '--build-info', paths.buildInfo, '--manifest', paths.manifest, '--output', paths.output, '--source-revision', 'a'.repeat(40)];
}

describe('record smoke evidence CLI', () => {
  it('exports an implicit source revision before building and requires one for reused native evidence', () => {
    const source = readFileSync(nativeSmokeScript, 'utf8');
    const exportRevision = source.indexOf('export STOREWEAVE_SOURCE_REVISION=');
    const buildRelease = source.indexOf('bash scripts/build-release.sh');
    expect(exportRevision).toBeGreaterThan(-1);
    expect(buildRelease).toBeGreaterThan(exportRevision);
    expect(source).toContain('Reused native artifact evidence requires explicit STOREWEAVE_SOURCE_REVISION');
  });

  it('writes native evidence with the artifact sha256', () => {
    const { paths, buildInfo } = fixture();
    run(['--kind', 'native', ...common(paths), '--artifact', paths.artifact]);
    const evidence = JSON.parse(readFileSync(paths.output, 'utf8'));
    expect(evidence).toMatchObject({ format: 'storeweave.release-smoke-evidence.v1', schemaVersion: 1, result: 'pass', kind: 'native', sourceRevision: 'a'.repeat(40), releaseId: 'commerce', releaseVersion: '1.2.3', buildInfoManifestChecksum: buildInfo.manifestChecksum, manifestChecksum: buildInfo.manifestChecksum, artifact: { name: 'release.tar.gz', digest: `sha256:${createHash('sha256').update('native artifact').digest('hex')}` } });
    expect(new Date(evidence.completedAt).toISOString()).toBe(evidence.completedAt);
  });

  it('writes docker evidence with its supplied immutable digest', () => {
    const { paths } = fixture();
    const digest = `sha256:${'a'.repeat(64)}`;
    run(['--kind', 'docker', ...common(paths), '--artifact-name', 'registry.example/commerce:1.2.3', '--artifact-digest', digest]);
    expect(JSON.parse(readFileSync(paths.output, 'utf8'))).toMatchObject({ kind: 'docker', artifact: { name: 'registry.example/commerce:1.2.3', digest } });
  });

  it('rejects a build-info checksum that does not match the canonical manifest', () => {
    const { paths, buildInfo } = fixture();
    writeFileSync(paths.buildInfo, JSON.stringify({ ...buildInfo, manifestChecksum: `sha256:${'b'.repeat(64)}` }));
    expect(() => run(['--kind', 'native', ...common(paths), '--artifact', paths.artifact])).toThrow(/does not match release manifest checksum/);
    expect(existsSync(paths.output)).toBe(false);
  });

  it('rejects evidence for a source revision different from the built artifact', () => {
    const { paths, buildInfo } = fixture();
    writeFileSync(paths.buildInfo, JSON.stringify({ ...buildInfo, sourceRevision: 'b'.repeat(40) }));
    expect(() => run(['--kind', 'native', ...common(paths), '--artifact', paths.artifact])).toThrow(/does not match expected source revision/);
    expect(existsSync(paths.output)).toBe(false);
  });

  it('rejects an unsupported release manifest schema before writing evidence', () => {
    const { paths, manifest, buildInfo } = fixture();
    const changed = { ...manifest, schemaVersion: 2 };
    writeFileSync(paths.manifest, JSON.stringify(changed));
    writeFileSync(paths.buildInfo, JSON.stringify({ ...buildInfo, manifestChecksum: catalogDigest(changed) }));
    expect(() => run(['--kind', 'native', ...common(paths), '--artifact', paths.artifact])).toThrow(/schemaVersion 1/);
    expect(existsSync(paths.output)).toBe(false);
  });

  it('refuses to overwrite an existing evidence output', () => {
    const { paths } = fixture();
    writeFileSync(paths.output, 'preserve');
    expect(() => run(['--kind', 'native', ...common(paths), '--artifact', paths.artifact])).toThrow(/Refusing to overwrite existing output/);
    expect(readFileSync(paths.output, 'utf8')).toBe('preserve');
  });
});
