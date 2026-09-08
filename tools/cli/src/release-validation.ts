import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, copyFileSync, cpSync, fstatSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, statSync, type Stats } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { catalogDigest } from '@storeweave/db';

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 1024n * 1024n * 1024n;
const MAX_MEMBERS = 10_000;
const MAX_PATH_BYTES = 1024;

/** Shared by native install and CLI upgrade/rollback. Validates structure, not publisher authenticity. */
export function validateReleaseDirectory(directory: string, expectedReleaseId?: string) {
  return withReleaseTree(directory, root => {
    const releaseId = readFileSync(join(root, 'RELEASE'), 'utf8').trim();
    const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
    if (!['base', 'commerce'].includes(releaseId) || (expectedReleaseId && releaseId !== expectedReleaseId)) throw new Error('Release identity mismatch');
    if (semver.valid(version) !== version) throw new Error('Invalid release version');
    const name = releaseId === 'commerce' ? 'commerce' : 'storeweave';
    const info = JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(root, 'release-manifest.json'), 'utf8'));
    const manifestChecksum = catalogDigest(manifest);
    if (info.releaseId !== releaseId || info.version !== version || manifest.releaseId !== releaseId
      || manifest.releaseVersion !== version || !semver.valid(manifest.baseVersion) || manifest.schemaVersion !== 1
      || manifestChecksum !== info.manifestChecksum) throw new Error('Release manifest or build metadata mismatch');
    for (const file of ['api', 'worker', 'cli', 'seed'].map(name => `app/${name}.js`).concat([
      'runtime/bin/node', `bin/${name}`, 'scripts/install.sh', 'scripts/validate-release.js',
      `config/${name}.yaml.example`, `config/${name}.env.example`,
      `systemd/${name}-api.service`, `systemd/${name}-worker.service`,
    ])) {
      if (!lstatSync(join(root, file)).isFile()) throw new Error(`Missing release file: ${file}`);
    }
    for (const file of ['runtime/bin/node', `bin/${name}`]) {
      if (!(lstatSync(join(root, file)).mode & 0o111)) throw new Error(`Release executable is not executable: ${file}`);
    }
    if (releaseId === 'base' && ['admin', 'theme-assets'].some(path => existsSync(join(root, path)))) throw new Error('Base release contains Commerce assets');
    return { releaseId, version, name, manifestChecksum };
  });
}

/** Only the explicit B01 bridge may call this; modern validation never falls back to it. */
export function validateLegacyB01Directory(directory: string) {
  return withReleaseTree(directory, root => {
    for (const marker of ['RELEASE', 'release-manifest.json', 'scripts/validate-release.js', 'app/seed.js']) {
      if (lstatSync(join(root, marker), { throwIfNoEntry: false })) throw new Error('Modern release markers cannot be accepted as legacy B01');
    }
    if (readFileSync(join(root, 'VERSION'), 'utf8').trim() !== '0.1.0') throw new Error('Legacy B01 requires Commerce 0.1.0');
    z.object({ version: z.literal('0.1.0'), builtOnNode: z.string().refine(value => Boolean(semver.valid(value))),
      entries: z.tuple([z.literal('/dist/app/api.js'), z.literal('/dist/app/worker.js'), z.literal('/dist/app/cli.js')]),
    }).strict().parse(JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8')));
    for (const file of ['app/api.js', 'app/worker.js', 'app/cli.js', 'bin/commerce', 'runtime/bin/node',
      'config/commerce.yaml.example', 'config/commerce.env.example', 'scripts/install.sh',
      'systemd/commerce-api.service', 'systemd/commerce-worker.service']) {
      if (!lstatSync(join(root, file)).isFile()) throw new Error(`Missing legacy B01 file: ${file}`);
    }
    for (const file of ['runtime/bin/node', 'bin/commerce']) {
      if (!(lstatSync(join(root, file)).mode & 0o111)) throw new Error(`Legacy B01 executable is not executable: ${file}`);
    }
    return { format: 'legacy-b01' as const, releaseId: 'commerce' as const, version: '0.1.0' as const, name: 'commerce' as const };
  });
}

function withReleaseTree<T>(directory: string, readMetadata: (root: string) => T) {
  const root = resolve(directory);
  const pending = [root];
  let members = 0;
  let bytes = 0n;
  const entries: { path: string; mode: number; type: string; size?: number; checksum?: string }[] = [];
  const files: { path: string; stat: Stats }[] = [];
  const directories: { path: string; stat: Stats; names: string[] }[] = [];
  const buffer = Buffer.alloc(1024 * 1024);
  while (pending.length) {
    const path = pending.pop()!;
    const stat = lstatSync(path);
    bytes += stat.isFile() ? BigInt(stat.size) : 0n;
    if (++members > MAX_MEMBERS || bytes > MAX_PAYLOAD_BYTES || Buffer.byteLength(relative(root, path)) > MAX_PATH_BYTES) {
      throw new Error('Release tree exceeds size, member or path limit');
    }
    if (/[\x00-\x1f\x7f]/.test(basename(path)) || (stat.mode & 0o6000)
      || stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error(`Unsupported release entry: ${path}`);
    }
    const entry = { path: relative(root, path), mode: stat.mode & 0o777, type: stat.isDirectory() ? 'directory' : 'file' };
    if (stat.isDirectory()) {
      entries.push(entry);
      const names = readdirSync(path).sort();
      directories.push({ path, stat, names });
      pending.push(...names.map(name => join(path, name)));
    } else {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) throw new Error('Release changed during validation');
        const hash = createHash('sha256');
        let size = 0;
        for (;;) {
          const count = readSync(descriptor, buffer, 0, buffer.length, null);
          if (!count) break;
          size += count;
          if (size > stat.size) throw new Error('Release changed during validation');
          hash.update(buffer.subarray(0, count));
        }
        const after = fstatSync(descriptor);
        if (size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Release changed during validation');
        entries.push({ ...entry, size, checksum: hash.digest('hex') });
        files.push({ path, stat });
      } finally { closeSync(descriptor); }
    }
  }
  const metadata = readMetadata(root);
  // Bind every path, permission and byte, including assets outside the build manifest.
  // Ownership and timestamps are intentionally excluded so a copied release has the same identity.
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const saved of files) {
    const current = lstatSync(saved.path);
    if (!current.isFile() || current.dev !== saved.stat.dev || current.ino !== saved.stat.ino || current.nlink !== saved.stat.nlink
      || current.mode !== saved.stat.mode || current.size !== saved.stat.size
      || current.mtimeMs !== saved.stat.mtimeMs || current.ctimeMs !== saved.stat.ctimeMs) throw new Error('Release file changed during validation');
  }
  for (const saved of directories) {
    const current = lstatSync(saved.path);
    if (!current.isDirectory() || current.dev !== saved.stat.dev || current.ino !== saved.stat.ino
      || current.mode !== saved.stat.mode || current.mtimeMs !== saved.stat.mtimeMs || current.ctimeMs !== saved.stat.ctimeMs
      || JSON.stringify(readdirSync(saved.path).sort()) !== JSON.stringify(saved.names)) throw new Error('Release directory changed during validation');
  }
  const treeChecksum = catalogDigest(entries);
  return { ...metadata, directory: root, treeChecksum };
}

function promoteRelease(release: ReturnType<typeof validateReleaseDirectory>, releasesDirectory: string, reuseExisting = false) {
  const target = join(releasesDirectory, release.version);
  if (reuseExisting && lstatSync(target, { throwIfNoEntry: false })) {
    const existing = validateReleaseDirectory(target, release.releaseId);
    if (existing.version !== release.version || existing.name !== release.name || existing.manifestChecksum !== release.manifestChecksum
      || existing.treeChecksum !== release.treeChecksum) throw new Error('Existing candidate differs from the supplied release');
    return existing;
  }
  // Exclusive reservation refuses existing files, directories and dangling symlinks.
  mkdirSync(target);
  // On failure leave the reservation: another writer may have replaced it, so cleanup cannot safely own it.
  renameSync(release.directory, target);
  return { ...release, directory: target };
}

/** The native installer validates the copied tree before exposing a final version. */
export function installReleaseDirectory(source: string, releasesDirectory: string, expectedReleaseId: string) {
  validateReleaseDirectory(source, expectedReleaseId);
  releasesDirectory = resolve(releasesDirectory);
  mkdirSync(releasesDirectory, { recursive: true });
  const incoming = mkdtempSync(join(releasesDirectory, '.incoming-'));
  try {
    const copied = join(incoming, 'contents');
    cpSync(resolve(source), copied, { recursive: true, force: false, errorOnExist: true });
    return promoteRelease(validateReleaseDirectory(copied, expectedReleaseId), releasesDirectory);
  } finally { rmSync(incoming, { recursive: true, force: true }); }
}

/** Only a newly-created private staging tree is recursively removed. */
export function installReleaseArchive(archive: string, releasesDirectory: string, expectedReleaseId: string, reuseExisting = false) {
  releasesDirectory = resolve(releasesDirectory);
  mkdirSync(releasesDirectory, { recursive: true });
  const incoming = mkdtempSync(join(releasesDirectory, '.incoming-'));
  try {
    const copy = join(incoming, 'archive.tar.gz');
    const sourceStat = statSync(resolve(archive));
    if (!sourceStat.isFile() || sourceStat.size > MAX_ARCHIVE_BYTES) throw new Error('Release archive must be a regular file within 256 MiB');
    copyFileSync(resolve(archive), copy);
    if (statSync(copy).size > MAX_ARCHIVE_BYTES) throw new Error('Release archive exceeds 256 MiB');
    const tarOptions = { encoding: 'utf8' as const, maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000, killSignal: 'SIGKILL' as const,
      env: { ...process.env, TAR_OPTIONS: '', LC_ALL: 'C' } };
    const contents = execFileSync('tar', ['-tzf', copy], tarOptions);
    const members = contents.split('\n').filter(Boolean);
    if (members.length > MAX_MEMBERS || members.some(name => Buffer.byteLength(name) > MAX_PATH_BYTES)) throw new Error('Release archive exceeds member or path limit');
    if (!members.length || members.some(name => name.startsWith('/') || name.split('/').includes('..') || /[\x00-\x1f\x7f]/.test(name))) {
      throw new Error('Unsafe release archive path');
    }
    // Inspect header modes too: tar may safely strip setuid bits during extraction, hiding a forbidden entry.
    const listing = execFileSync('tar', ['--numeric-owner', '-tvzf', copy], tarOptions).split('\n').filter(Boolean);
    if (listing.length !== members.length) throw new Error('Inconsistent release archive listings');
    let bytes = 0n;
    for (const line of listing) {
      // Numeric GNU (uid/gid) and bsdtar (links uid gid) prefixes only; unknown formats fail closed.
      const header = /^[d-][rwx-]{9}[+@.]?\s+(?:\d+\/\d+\s+(\d+)|\d+\s+\d+\s+\d+\s+(\d+))\s/.exec(line);
      if (!header) throw new Error('Unsupported release archive entry type, mode or header');
      bytes += BigInt(header[1] ?? header[2]!);
      if (bytes > MAX_PAYLOAD_BYTES) throw new Error('Release archive expanded payload exceeds 1 GiB');
    }
    const extracted = join(incoming, 'contents');
    mkdirSync(extracted);
    // Keep root extraction from restoring archive ownership or extended metadata.
    execFileSync('tar', ['--no-same-owner', '--no-same-permissions', '--no-acls', '--no-xattrs', '-xzf', copy, '-C', extracted], { ...tarOptions, timeout: 300_000 });
    const roots = readdirSync(extracted);
    if (roots.length !== 1 || !lstatSync(join(extracted, roots[0]!)).isDirectory()) throw new Error('Release archive must have one root directory');
    const release = validateReleaseDirectory(join(extracted, roots[0]!), expectedReleaseId);
    if (roots[0] !== `${release.name}-${release.version}`) throw new Error('Release archive root does not match its metadata');
    return promoteRelease(release, releasesDirectory, reuseExisting);
  } finally { rmSync(incoming, { recursive: true, force: true }); }
}
