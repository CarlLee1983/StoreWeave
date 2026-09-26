import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogDigest } from '@storeweave/db';
import { afterEach, describe, expect, it } from 'vitest';
import { pairedSnapshotSchema } from '../../tools/cli/src/read-release-snapshot';
import { validateReleaseDirectory } from '../../tools/cli/src/release-validation';
import { fullBackupSchema } from '../../tools/cli/src/storage-backup';
import { writeNativeRelease } from './fixtures/native-release';

type Assets = { admin: boolean; themeAssets: boolean };
type Layout = { schemaVersion: number; releaseId: string; name: string; assets: Assets };

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(releaseId = 'booking', name = releaseId, assets: Assets = { admin: false, themeAssets: false }) {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-native-layout-'));
  directories.push(directory);
  writeNativeRelease(directory);
  writeFileSync(join(directory, 'RELEASE'), `${releaseId}\n`);
  const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8')) as Record<string, unknown>;
  manifest.releaseId = releaseId;
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'build-info.json'), JSON.stringify({
    releaseId, version: '1.0.0', manifestChecksum: catalogDigest(manifest), nativeLayoutVersion: 1,
  }));
  for (const [from, to] of [
    ['bin/commerce', `bin/${name}`],
    ['config/commerce.yaml.example', `config/${name}.yaml.example`],
    ['config/commerce.env.example', `config/${name}.env.example`],
    ['systemd/commerce-api.service', `systemd/${name}-api.service`],
    ['systemd/commerce-worker.service', `systemd/${name}-worker.service`],
  ]) renameSync(join(directory, from), join(directory, to));
  if (assets.admin) {
    mkdirSync(join(directory, 'admin'));
    writeFileSync(join(directory, 'admin/index.html'), '<main>Admin</main>');
  }
  if (assets.themeAssets) mkdirSync(join(directory, 'theme-assets'));
  const layout: Layout = { schemaVersion: 1, releaseId, name, assets };
  writeFileSync(join(directory, 'native-layout.json'), JSON.stringify(layout));
  return { directory, layout };
}

function writeLayout(directory: string, layout: unknown) {
  writeFileSync(join(directory, 'native-layout.json'), JSON.stringify(layout));
}

describe('native release layout descriptor', () => {
  it.each(['booking', 'lodging', 'a'.repeat(64)])('accepts generic %s identity without a release-ID allowlist', releaseId => {
    const { directory } = fixture(releaseId);
    const result = validateReleaseDirectory(directory, releaseId);
    expect(result).toMatchObject({ releaseId, version: '1.0.0', name: releaseId, directory });
    expect(Object.keys(result).sort()).toEqual([
      'directory', 'manifestChecksum', 'name', 'releaseId', 'treeChecksum', 'version',
    ]);
    expect(result.manifestChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.treeChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('accepts declared Admin and Theme assets only when their required paths exist', () => {
    const { directory } = fixture('booking', 'booking', { admin: true, themeAssets: true });
    expect(validateReleaseDirectory(directory, 'booking').name).toBe('booking');
    rmSync(join(directory, 'admin/index.html'));
    expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
    writeFileSync(join(directory, 'admin/index.html'), '<main>Admin</main>');
    rmSync(join(directory, 'theme-assets'), { recursive: true });
    expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
  });

  it.each(['admin', 'theme-assets'])('rejects undeclared %s assets', path => {
    const { directory } = fixture();
    mkdirSync(join(directory, path));
    if (path === 'admin') writeFileSync(join(directory, path, 'index.html'), '<main>Admin</main>');
    expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
  });

  it.each(['schemaVersion', 'unknownField'])('rejects an unsupported descriptor %s without fallback', kind => {
    const { directory, layout } = fixture('commerce');
    writeLayout(directory, kind === 'schemaVersion' ? { ...layout, schemaVersion: 2 } : { ...layout, extra: true });
    expect(() => validateReleaseDirectory(directory, 'commerce')).toThrow();
  });

  it('does not fall back to a historical layout when the marker remains but the descriptor and assets are removed', () => {
    const { directory } = fixture('commerce', 'commerce', { admin: true, themeAssets: true });
    rmSync(join(directory, 'native-layout.json'));
    rmSync(join(directory, 'admin'), { recursive: true });
    rmSync(join(directory, 'theme-assets'), { recursive: true });
    expect(() => validateReleaseDirectory(directory, 'commerce')).toThrow();
  });

  it('rejects an unknown native layout marker even with a valid descriptor', () => {
    const { directory } = fixture();
    const info = JSON.parse(readFileSync(join(directory, 'build-info.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify({ ...info, nativeLayoutVersion: 2 }));
    expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
  });

  it('rejects a descriptor without its build-info marker instead of treating Commerce as historical', () => {
    const { directory } = fixture('commerce');
    const info = JSON.parse(readFileSync(join(directory, 'build-info.json'), 'utf8')) as Record<string, unknown>;
    delete info.nativeLayoutVersion;
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify(info));
    expect(() => validateReleaseDirectory(directory, 'commerce')).toThrow();
  });

  it.each(['', '../outside', '/absolute', '-leading', '1leading', 'Uppercase', 'under_score', 'a'.repeat(65)])(
    'rejects unsafe descriptor identity %s', value => {
      const { directory, layout } = fixture();
      writeLayout(directory, { ...layout, releaseId: value });
      expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
      writeLayout(directory, { ...layout, name: value });
      expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
    },
  );

  it.each(['RELEASE', 'build-info.json', 'release-manifest.json', 'expected'])('rejects identity mismatch in %s', source => {
    const { directory } = fixture();
    if (source === 'RELEASE') writeFileSync(join(directory, 'RELEASE'), 'lodging\n');
    if (source === 'build-info.json') {
      const info = JSON.parse(readFileSync(join(directory, source), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(directory, source), JSON.stringify({ ...info, releaseId: 'lodging' }));
    }
    if (source === 'release-manifest.json') {
      const manifest = JSON.parse(readFileSync(join(directory, source), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(directory, source), JSON.stringify({ ...manifest, releaseId: 'lodging' }));
    }
    expect(() => validateReleaseDirectory(directory, source === 'expected' ? 'lodging' : 'booking')).toThrow();
  });

  it.each([
    'app/worker.js', 'runtime/bin/node', 'bin/booking', 'scripts/install.sh',
    'config/booking.yaml.example', 'config/booking.env.example',
    'systemd/booking-api.service', 'systemd/booking-worker.service',
  ])('requires native file %s for a generic release', path => {
    const { directory } = fixture();
    rmSync(join(directory, path));
    expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
  });

  it('rejects an app-only Booking dist without native scripts, runtime and configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-app-only-booking-'));
    directories.push(directory);
    const manifest = { schemaVersion: 1, releaseId: 'booking', releaseVersion: '1.0.0', baseVersion: '1.0.0' };
    writeFileSync(join(directory, 'RELEASE'), 'booking\n');
    writeFileSync(join(directory, 'VERSION'), '1.0.0\n');
    writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify({
      releaseId: 'booking', version: '1.0.0', manifestChecksum: catalogDigest(manifest), nativeLayoutVersion: 1,
    }));
    writeLayout(directory, { schemaVersion: 1, releaseId: 'booking', name: 'booking',
      assets: { admin: false, themeAssets: false } });
    mkdirSync(join(directory, 'app'));
    for (const entry of ['api', 'worker', 'cli', 'seed']) writeFileSync(join(directory, 'app', `${entry}.js`), '// built');
    expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
  });

  it.each(['base', 'commerce'])('preserves descriptor-less historical %s fixture', releaseId => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-native-legacy-'));
    directories.push(directory);
    writeNativeRelease(directory, releaseId);
    expect(existsSync(join(directory, 'native-layout.json'))).toBe(false);
    const result = validateReleaseDirectory(directory, releaseId);
    expect(result).toMatchObject({ releaseId, name: releaseId === 'base' ? 'storeweave' : 'commerce' });
    expect(Object.keys(result).sort()).toEqual([
      'directory', 'manifestChecksum', 'name', 'releaseId', 'treeChecksum', 'version',
    ]);
  });

  it('rejects descriptor-less unknown release identity', () => {
    const { directory } = fixture('booking');
    rmSync(join(directory, 'native-layout.json'));
    const info = JSON.parse(readFileSync(join(directory, 'build-info.json'), 'utf8')) as Record<string, unknown>;
    delete info.nativeLayoutVersion;
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify(info));
    expect(() => validateReleaseDirectory(directory, 'booking')).toThrow();
  });

  it('accepts generic release identities in paired snapshots and full backups', () => {
    for (const value of ['booking', 'lodging', 'a'.repeat(64)]) {
      expect(pairedSnapshotSchema.shape.source.shape.releaseId.safeParse(value).success).toBe(true);
      expect(pairedSnapshotSchema.shape.source.shape.name.safeParse(value).success).toBe(true);
      expect(pairedSnapshotSchema.shape.evidence.shape.release.shape.releaseId.safeParse(value).success).toBe(true);
      expect(fullBackupSchema.shape.release.shape.id.safeParse(value).success).toBe(true);
    }
    for (const value of ['../outside', 'Uppercase', 'a'.repeat(65)]) {
      expect(pairedSnapshotSchema.shape.source.shape.releaseId.safeParse(value).success).toBe(false);
      expect(pairedSnapshotSchema.shape.source.shape.name.safeParse(value).success).toBe(false);
      expect(pairedSnapshotSchema.shape.evidence.shape.release.shape.releaseId.safeParse(value).success).toBe(false);
      expect(fullBackupSchema.shape.release.shape.id.safeParse(value).success).toBe(false);
    }
  });
});
