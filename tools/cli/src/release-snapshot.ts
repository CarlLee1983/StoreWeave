import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalogDigest, type ReleaseSnapshot } from '@storeweave/db';
import { parsePgUrl, writePgBackup } from './pg-tool';
import { validateReleaseDirectory } from './release-validation';

/** Private CLI snapshot boundary. Call only after managed and external writers have drained. */
export async function createPairedSnapshot(options: {
  databaseUrl: string; sourceDirectory: string; candidateDirectory: string; snapshotDirectory: string; lockFd?: number;
}, capture: <T>(dump: (snapshot: ReleaseSnapshot) => Promise<T>) => Promise<T>) {
  const url = parsePgUrl(options.databaseUrl);
  if (!url.hostname || !url.pathname || url.pathname === '/') throw new Error('Paired snapshots require an explicit database host and name');
  const port = url.port || process.env.PGPORT || '5432';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid PostgreSQL port');
  url.port = port;
  const source = validateReleaseDirectory(options.sourceDirectory);
  const candidate = validateReleaseDirectory(options.candidateDirectory, source.releaseId);
  const root = resolve(options.snapshotDirectory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(root, '.snapshot-'));
  const id = randomUUID();
  const destination = join(root, id);
  try {
    const manifest = await capture(async evidence => {
      if (decodeURIComponent(url.pathname.slice(1)) !== evidence.database.name) throw new Error('Snapshot database name does not match the connection');
      if (evidence.release.releaseId !== source.releaseId || evidence.release.releaseVersion !== source.version
        || evidence.release.buildManifestChecksum !== source.manifestChecksum) throw new Error('Snapshot database does not match the source release');
      const dump = join(staging, 'database.dump');
      await writePgBackup(url.toString(), dump, evidence.snapshotId, options.lockFd);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(dump)) digest.update(chunk);
      if (validateReleaseDirectory(source.directory).treeChecksum !== source.treeChecksum
        || validateReleaseDirectory(candidate.directory).treeChecksum !== candidate.treeChecksum) throw new Error('Release changed during snapshot');
      // Keep endpoint credentials and transient exported-snapshot identifiers out of durable evidence.
      const endpointChecksum = catalogDigest({ host: url.hostname, port: url.port || '5432', database: evidence.database.name });
      const { snapshotId: _snapshotId, ...databaseEvidence } = evidence;
      const value = { schemaVersion: 1, id, createdAt: new Date().toISOString(), source, candidate,
        endpointChecksum, evidence: databaseEvidence, dump: { file: 'database.dump', bytes: statSync(dump).size, checksum: digest.digest('hex') } };
      const file = join(staging, 'snapshot.json');
      writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
      sync(file);
      sync(staging);
      return value;
    });
    if (validateReleaseDirectory(source.directory).treeChecksum !== source.treeChecksum
      || validateReleaseDirectory(candidate.directory).treeChecksum !== candidate.treeChecksum) throw new Error('Release changed before snapshot publication');
    // capture must resolve after COMMIT and advisory unlock. A failed commit must never publish a pair.
    mkdirSync(destination, { mode: 0o700 });
    // Reserve exclusively; never clean a final path if publication fails or another actor replaced it.
    renameSync(staging, destination);
    sync(root);
    return { directory: destination, manifest, manifestChecksum: catalogDigest(manifest) };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function sync(path: string) {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
