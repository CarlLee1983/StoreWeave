import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReleaseArchive, installReleaseDirectory, validateLegacyB01Directory, validateReleaseDirectory } from '../../tools/cli/src/release-validation';
import { writeNativeRelease } from './fixtures/native-release';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, cpSync: vi.fn(actual.cpSync), readdirSync: vi.fn(actual.readdirSync), readFileSync: vi.fn(actual.readFileSync), renameSync: vi.fn(actual.renameSync) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let directory: string;
let releases: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'storeweave-release-validation-'));
  releases = join(directory, 'releases');
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); rmSync(directory, { recursive: true, force: true }); });
function archive(releaseId = 'commerce') {
  const name = releaseId === 'commerce' ? 'commerce' : 'storeweave';
  const folder = `${name}-1.0.0`;
  const source = join(directory, folder);
  writeNativeRelease(source, releaseId);
  const file = join(directory, 'arbitrary-name.tar.gz');
  const pack = () => execFileSync('tar', ['-czf', file, '-C', directory, folder], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  pack();
  return { source, file, pack };
}
function unsafeArchive(entries: { name: string; type?: string; link?: string; mode?: number }[]) {
  const file = join(directory, 'unsafe.tar.gz');
  const source = join(directory, 'commerce-1.0.0');
  writeNativeRelease(source);
  // Python's standard tarfile writer creates precise hostile fixtures; production uses system tar.
  execFileSync('python3', ['-c', `
import io,json,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
 archive.add(sys.argv[3], arcname='commerce-1.0.0')
 for entry in json.loads(sys.argv[2]):
  info=tarfile.TarInfo(entry['name']); info.mode=entry.get('mode', 0o755)
  info.type={'file':tarfile.REGTYPE,'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE,'device':tarfile.CHRTYPE,'directory':tarfile.DIRTYPE}[entry.get('type','file')]
  info.linkname=entry.get('link','')
  if info.type==tarfile.REGTYPE:
   info.size=6; archive.addfile(info,io.BytesIO(b'unsafe'))
  else: archive.addfile(info)
`, file, JSON.stringify(entries), source]);
  return file;
}
function expectNoPromotion() {
  expect(readdirSync(releases)).toEqual([]);
}

describe('native release validation and staging', () => {
  it('rejects an oversized sparse archive before invoking tar', () => {
    const file = join(directory, 'large.tar.gz');
    writeFileSync(file, '');
    fs.truncateSync(file, 256 * 1024 * 1024 + 1);
    vi.mocked(execFileSync).mockClear();
    expect(() => installReleaseArchive(file, releases, 'commerce')).toThrow('256 MiB');
    expect(execFileSync).not.toHaveBeenCalled();
    expectNoPromotion();
  });

  it('rejects a native directory with excessive logical payload before copying', () => {
    const { source } = archive();
    const file = join(source, 'large');
    writeFileSync(file, '');
    fs.truncateSync(file, 1024 * 1024 * 1024 + 1);
    expect(() => installReleaseDirectory(source, releases, 'commerce')).toThrow('exceeds size');
    expect(fs.cpSync).not.toHaveBeenCalled();
    expect(existsSync(releases)).toBe(false);
  });

  it.each(['members', 'path'])('rejects an archive exceeding its %s limit', kind => {
    const entries = kind === 'members'
      ? Array.from({ length: 10_001 }, (_, index) => ({ name: `commerce-1.0.0/${index}` }))
      : [{ name: `commerce-1.0.0/${'nested/'.repeat(150)}file` }];
    expect(() => installReleaseArchive(unsafeArchive(entries), releases, 'commerce')).toThrow('member or path limit');
    expectNoPromotion();
  });

  it.each(['format', 'count', 'size'])('rejects invalid numeric header %s before extraction', kind => {
    const { file } = archive();
    const header = kind === 'format' ? '-rw-r--r-- owner/group 3 Jan 1 file\n'
      : kind === 'size' ? '-rw-r--r-- 0/0 999999999999999999999999 Jan 1 file\n' : '';
    vi.mocked(execFileSync).mockClear();
    vi.mocked(execFileSync).mockReturnValueOnce('commerce-1.0.0/file\n').mockReturnValueOnce(header);
    expect(() => installReleaseArchive(file, releases, 'commerce')).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expectNoPromotion();
  });

  it('bounds inspection and extraction child processes', () => {
    const { file } = archive();
    vi.mocked(execFileSync).mockClear();
    installReleaseArchive(file, releases, 'commerce');
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]![2]).toMatchObject({ timeout: 60_000, killSignal: 'SIGKILL' });
    expect(calls[1]![2]).toMatchObject({ timeout: 60_000, killSignal: 'SIGKILL' });
    expect(calls[2]![2]).toMatchObject({ timeout: 300_000, killSignal: 'SIGKILL' });
  });

  it.each(['base', 'commerce'])('installs a copied %s tree atomically', releaseId => {
    const { source } = archive(releaseId);
    const result = installReleaseDirectory(source, releases, releaseId);
    expect(result.directory).toBe(join(releases, '1.0.0'));
    expect(validateReleaseDirectory(result.directory, releaseId).manifestChecksum).toBe(result.manifestChecksum);
    expect(existsSync(source)).toBe(true);
    expect(readdirSync(releases)).toEqual(['1.0.0']);
  });

  it.each(['interrupted', 'mutated', 'concurrent'])('preserves final state when a native copy is %s', async failure => {
    const { source } = archive();
    const { cpSync: copy } = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.cpSync).mockImplementationOnce((from, to, options) => {
      copy(from, to, options);
      if (failure === 'interrupted') throw new Error('copy interrupted');
      if (failure === 'mutated') writeFileSync(join(String(to), 'VERSION'), '2.0.0');
      if (failure === 'concurrent') {
        mkdirSync(join(releases, '1.0.0'));
        writeFileSync(join(releases, '1.0.0', 'sentinel'), 'preserve');
      }
    });
    expect(() => installReleaseDirectory(source, releases, 'commerce')).toThrow();
    if (failure === 'concurrent') {
      expect(readdirSync(releases)).toEqual(['1.0.0']);
      expect(readdirSync(join(releases, '1.0.0'))).toEqual(['sentinel']);
      expect(readFileSync(join(releases, '1.0.0', 'sentinel'), 'utf8')).toBe('preserve');
    } else expectNoPromotion();
  });

  it.each(['directory', 'file', 'symlink'])('preserves an existing final %s on archive and directory installs', kind => {
    const { source, file } = archive();
    mkdirSync(releases);
    const target = join(releases, '1.0.0');
    if (kind === 'directory') { mkdirSync(target); writeFileSync(join(target, 'sentinel'), 'preserve'); }
    if (kind === 'file') writeFileSync(target, 'preserve');
    if (kind === 'symlink') symlinkSync('missing', target);
    const before = fs.lstatSync(target);
    expect(() => installReleaseArchive(file, releases, 'commerce')).toThrow();
    expect(() => installReleaseDirectory(source, releases, 'commerce')).toThrow();
    expect(fs.lstatSync(target).ino).toBe(before.ino);
    expect(readdirSync(releases)).toEqual(['1.0.0']);
    if (kind === 'directory') expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('preserve');
    if (kind === 'file') expect(readFileSync(target, 'utf8')).toBe('preserve');
    if (kind === 'symlink') expect(fs.readlinkSync(target)).toBe('missing');
  });

  it('does not remove a substituted empty reservation when promotion fails', () => {
    const { source } = archive();
    const target = join(releases, '1.0.0');
    let replacementInode: number | bigint | undefined;
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      fs.rmdirSync(target);
      mkdirSync(target);
      replacementInode = fs.lstatSync(target).ino;
      throw new Error('promotion failed');
    });
    expect(() => installReleaseDirectory(source, releases, 'commerce')).toThrow('promotion failed');
    expect(readdirSync(releases)).toEqual(['1.0.0']);
    expect(fs.lstatSync(target).ino).toBe(replacementInode);
    expect(readdirSync(target)).toEqual([]);
  });

  it.each(['base', 'commerce'])('promotes %s using validated metadata, independent of the archive filename', releaseId => {
    const { file } = archive(releaseId);
    const result = installReleaseArchive(file, releases, releaseId);
    expect(result).toMatchObject({ releaseId, version: '1.0.0', directory: join(releases, '1.0.0') });
    expect(readdirSync(releases)).toEqual(['1.0.0']);
    expect(validateReleaseDirectory(result.directory, releaseId).manifestChecksum).toBe(result.manifestChecksum);
  });

  it.each(['checksum', 'identity', 'version', 'required file'])('rejects invalid %s before creating a final directory', kind => {
    const { source, file, pack } = archive();
    if (kind === 'checksum') writeFileSync(join(source, 'release-manifest.json'), '{}');
    if (kind === 'identity') writeFileSync(join(source, 'RELEASE'), 'base');
    if (kind === 'version') writeFileSync(join(source, 'VERSION'), '01.0.0');
    if (kind === 'required file') rmSync(join(source, 'app', 'worker.js'));
    pack();
    expect(() => installReleaseArchive(file, releases, 'commerce')).toThrow();
    expectNoPromotion();
  });

  it('preserves an existing empty final directory and removes truncated staging', () => {
    const { file } = archive();
    mkdirSync(join(releases, '1.0.0'), { recursive: true });
    expect(() => installReleaseArchive(file, releases, 'commerce')).toThrow();
    expect(readdirSync(join(releases, '1.0.0'))).toEqual([]);
    expect(readdirSync(releases)).toEqual(['1.0.0']);
    rmSync(join(releases, '1.0.0'), { recursive: true });
    writeFileSync(file, readFileSync(file).subarray(0, 80));
    expect(() => installReleaseArchive(file, releases, 'commerce')).toThrow();
    expectNoPromotion();
  });

  it.each(['parent', 'absolute', 'symlink-child'])('rejects %s escape without changing an outside sentinel', kind => {
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    const sentinel = join(outside, 'sentinel');
    writeFileSync(sentinel, 'preserve');
    const entries = kind === 'parent' ? [{ name: '../../../outside/sentinel' }]
      : kind === 'absolute' ? [{ name: sentinel }]
        : [{ name: 'commerce-1.0.0/link', type: 'symlink', link: outside }, { name: 'commerce-1.0.0/link/sentinel' }];
    expect(() => installReleaseArchive(unsafeArchive(entries), releases, 'commerce')).toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
    expectNoPromotion();
  });

  it('rejects a root name inconsistent with validated metadata', () => {
    const { source, file } = archive();
    renameSync(source, join(directory, 'wrong-root'));
    execFileSync('tar', ['-czf', file, '-C', directory, 'wrong-root'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    expect(() => installReleaseArchive(file, releases, 'commerce')).toThrow('root does not match');
    expectNoPromotion();
  });

  it.each(['root-symlink', 'symlink', 'hardlink', 'fifo', 'device', 'setuid', 'control', 'multiple-roots'])('rejects unsupported %s entries', kind => {
    const entries = kind === 'multiple-roots' ? [{ name: 'one/file' }, { name: 'two/file' }]
      : kind === 'root-symlink' ? [{ name: 'commerce-1.0.0', type: 'symlink', link: directory }]
      : kind === 'control' ? [{ name: 'commerce-1.0.0/new\nline' }]
        : kind === 'setuid' ? [{ name: 'commerce-1.0.0/privileged', mode: 0o4755 }]
          : [{ name: 'commerce-1.0.0/first' }, { name: 'commerce-1.0.0/second', type: kind, link: 'commerce-1.0.0/first' }];
    expect(() => installReleaseArchive(unsafeArchive(entries), releases, 'commerce')).toThrow();
    expectNoPromotion();
    expect(existsSync(join(releases, '1.0.0'))).toBe(false);
  });
});


it('fingerprints all release bytes, names and modes while remaining stable across copies and timestamps', () => {
  const source = join(directory, 'source');
  writeNativeRelease(source);
  mkdirSync(join(source, 'assets'));
  writeFileSync(join(source, 'assets', 'extra.txt'), 'original');
  const original = validateReleaseDirectory(source);
  const copied = join(directory, 'copy');
  fs.cpSync(source, copied, { recursive: true });
  fs.utimesSync(join(copied, 'app', 'api.js'), 1, 1);
  expect(validateReleaseDirectory(copied).treeChecksum).toBe(original.treeChecksum);
  const extra = join(copied, 'assets', 'extra.txt');
  writeFileSync(extra, 'modified');
  expect(validateReleaseDirectory(copied).treeChecksum).not.toBe(original.treeChecksum);
  writeFileSync(extra, 'original');
  expect(validateReleaseDirectory(copied).treeChecksum).toBe(original.treeChecksum);
  fs.chmodSync(extra, 0o600);
  expect(validateReleaseDirectory(copied).treeChecksum).not.toBe(original.treeChecksum);
  fs.chmodSync(extra, fs.statSync(join(source, 'assets', 'extra.txt')).mode & 0o777);
  renameSync(extra, join(copied, 'assets', 'renamed.txt'));
  expect(validateReleaseDirectory(copied).treeChecksum).not.toBe(original.treeChecksum);
  renameSync(join(copied, 'assets', 'renamed.txt'), extra);
  mkdirSync(join(copied, 'empty'));
  expect(validateReleaseDirectory(copied).treeChecksum).not.toBe(original.treeChecksum);
  expect(validateReleaseDirectory(copied).manifestChecksum).toBe(original.manifestChecksum);
});


it.each(['add', 'remove', 'swap'])('rejects a directory %s after its first enumeration', async mutation => {
  const source = join(directory, 'source');
  writeNativeRelease(source);
  const assets = join(source, 'assets');
  mkdirSync(assets);
  writeFileSync(join(assets, 'original.txt'), 'original');
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let changed = false;
  vi.mocked(fs.readdirSync).mockImplementation(((path: Parameters<typeof fs.readdirSync>[0], options: unknown) => {
    const result = Reflect.apply(actual.readdirSync, actual, [path, options]);
    if (String(path) === assets && !changed) {
      changed = true;
      if (mutation === 'add') writeFileSync(join(assets, 'new.txt'), 'new');
      if (mutation === 'remove') fs.unlinkSync(join(assets, 'original.txt'));
      if (mutation === 'swap') {
        actual.renameSync(assets, join(directory, 'retained-assets'));
        mkdirSync(assets);
        writeFileSync(join(assets, 'original.txt'), 'original');
      }
    }
    return result;
  }) as typeof fs.readdirSync);
  expect(() => validateReleaseDirectory(source)).toThrow();
  expect(changed).toBe(true);
});


it('rejects an in-place file edit after hashing during metadata validation', async () => {
  const source = join(directory, 'source');
  writeNativeRelease(source);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  let changed = false;
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (!changed) {
      changed = true;
      writeFileSync(join(source, 'app', 'api.js'), '// changed after hashing');
    }
    return Reflect.apply(actual.readFileSync, actual, args);
  }) as typeof fs.readFileSync);
  expect(() => validateReleaseDirectory(source)).toThrow('Release file changed');
});


function legacyB01Fixture() {
  const source = join(directory, 'commerce-0.1.0');
  writeNativeRelease(source, 'commerce', '0.1.0');
  for (const file of ['RELEASE', 'release-manifest.json', 'scripts/validate-release.js', 'app/seed.js']) rmSync(join(source, file));
  writeFileSync(join(source, 'build-info.json'), JSON.stringify({ version: '0.1.0', builtOnNode: 'v22.17.1',
    entries: ['/dist/app/api.js', '/dist/app/worker.js', '/dist/app/cli.js'] }));
  return source;
}

it('recognizes only the explicit historical layout and binds all recovery bytes without fabricating a manifest', () => {
  const source = legacyB01Fixture();
  const before = validateLegacyB01Directory(source);
  expect(before).toMatchObject({ format: 'legacy-b01', releaseId: 'commerce', version: '0.1.0' });
  expect(before).not.toHaveProperty('manifestChecksum');
  expect(() => validateReleaseDirectory(source)).toThrow();
  writeFileSync(join(source, 'app/worker.js'), '// changed historical recovery bytes');
  expect(validateLegacyB01Directory(source).treeChecksum).not.toBe(before.treeChecksum);
});

it.each(['RELEASE', 'release-manifest.json', 'scripts/validate-release.js', 'app/seed.js'])('refuses a legacy fallback when modern marker %s exists, even if corrupt', marker => {
  const source = legacyB01Fixture();
  writeFileSync(join(source, marker), 'corrupt');
  expect(() => validateLegacyB01Directory(source)).toThrow('Modern release markers');
});

it.each(['version', 'entries', 'extra'])('rejects changed B01 build metadata: %s', key => {
  const source = legacyB01Fixture(), file = join(source, 'build-info.json');
  const info = JSON.parse(readFileSync(file, 'utf8'));
  if (key === 'version') info.version = '0.1.1';
  if (key === 'entries') info.entries.push('/dist/app/seed.js');
  if (key === 'extra') info.manifestChecksum = 'pretend-modern';
  writeFileSync(file, JSON.stringify(info));
  expect(() => validateLegacyB01Directory(source)).toThrow();
});

it('rejects linked B01 recovery executables through the same bounded tree rules', () => {
  const source = legacyB01Fixture();
  rmSync(join(source, 'runtime/bin/node'));
  symlinkSync(process.execPath, join(source, 'runtime/bin/node'));
  expect(() => validateLegacyB01Directory(source)).toThrow('Unsupported release entry');
});

it('reuses an exact archive candidate only for explicit retry and preserves different same-version bytes', () => {
  const { file, source, pack } = archive();
  const installed = installReleaseArchive(file, releases, 'commerce');
  expect(installReleaseArchive(file, releases, 'commerce', true)).toEqual(installed);
  expect(() => installReleaseArchive(file, releases, 'commerce')).toThrow();
  const before = readFileSync(join(installed.directory, 'app/worker.js'));
  writeFileSync(join(source, 'app/worker.js'), '// different same-version candidate');
  pack();
  expect(() => installReleaseArchive(file, releases, 'commerce', true)).toThrow('Existing candidate differs');
  expect(readFileSync(join(installed.directory, 'app/worker.js'))).toEqual(before);
});
