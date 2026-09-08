import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { catalogDigest, withLegacySafetySnapshot } from '@storeweave/db';
import type { Pool } from 'pg';
import { z } from 'zod';
import { parsePgUrl, writePgBackup } from './pg-tool';
import { pairedSnapshotSchema, readPrivateJson, verifyPrivateDump, writePrivateJson } from './read-release-snapshot';
import { validateLegacyB01Directory, validateReleaseDirectory } from './release-validation';

/** Explicit B01 bridge only. Caller holds the local operation lock and keeps all writers stopped. */
export async function createLegacySafetySnapshot(pool: Pool, options: {
  databaseUrl: string; sourceDirectory: string; candidateDirectory: string; operationRoot: string; lockFd?: number;
}) {
  const root = resolve(options.operationRoot), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('Legacy safety root must be owned and 0700');
  const url = parsePgUrl(options.databaseUrl);
  if (!url.hostname || url.pathname === '/' || !url.pathname) throw new Error('Legacy safety snapshot requires an explicit endpoint');
  url.port = url.port || process.env.PGPORT || '5432';
  const source = validateLegacyB01Directory(options.sourceDirectory);
  const candidate = validateReleaseDirectory(options.candidateDirectory, 'commerce');
  if (candidate.version === source.version) throw new Error('B01 bridge requires a distinct candidate release version');
  const staging = mkdtempSync(join(root, '.legacy-safety-'));
  const id = randomUUID(), destination = join(root, id);
  const verifyArtifacts = () => {
    if (validateLegacyB01Directory(source.directory).treeChecksum !== source.treeChecksum
      || validateReleaseDirectory(candidate.directory, 'commerce').treeChecksum !== candidate.treeChecksum) throw new Error('B01 bridge artifacts changed during safety capture');
  };
  try {
    const manifest = await withLegacySafetySnapshot(pool, async captured => {
      if (captured.database.name !== decodeURIComponent(url.pathname.slice(1))) throw new Error('Legacy safety database name mismatch');
      const dump = join(staging, 'database.dump');
      await writePgBackup(url.toString(), dump, captured.snapshotId, options.lockFd);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(dump)) hash.update(chunk);
      verifyArtifacts();
      const { snapshotId: _transient, ...evidence } = captured;
      const value = { schemaVersion: 1, kind: 'legacy-b01-safety' as const, id, createdAt: new Date().toISOString(), source, candidate, evidence,
        endpointChecksum: catalogDigest({ host: url.hostname, port: url.port, database: captured.database.name }),
        dump: { file: 'database.dump', bytes: statSync(dump).size, checksum: hash.digest('hex') } };
      writePrivateJson(join(staging, 'safety.json'), value);
      return value;
    });
    // Publication follows PostgreSQL COMMIT and advisory unlock. Never replace an existing final directory.
    verifyArtifacts();
    mkdirSync(destination, { mode: 0o700 });
    renameSync(staging, destination);
    const fd = openSync(root, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return { directory: destination, manifest, manifestChecksum: catalogDigest(manifest) };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}


export const legacySafetySnapshotSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('legacy-b01-safety'), id: z.string().uuid(), createdAt: z.string().datetime(),
  source: z.object({ format: z.literal('legacy-b01'), releaseId: z.literal('commerce'), version: z.literal('0.1.0'), name: z.literal('commerce'),
    directory: z.string().refine(isAbsolute), treeChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  candidate: pairedSnapshotSchema.shape.candidate,
  evidence: z.object({ database: pairedSnapshotSchema.shape.evidence.shape.database,
    migrationsChecksum: pairedSnapshotSchema.shape.evidence.shape.migrationsChecksum }).strict(),
  endpointChecksum: pairedSnapshotSchema.shape.endpointChecksum, dump: pairedSnapshotSchema.shape.dump,
}).strict();

/** The digest comes from the bridge journal or the explicitly retained safety-capture output. */
export async function readLegacySafetySnapshot(directory: string, expectedChecksum: string) {
  directory = resolve(directory);
  const raw = readPrivateJson(join(directory, 'safety.json'));
  if (catalogDigest(raw) !== expectedChecksum) throw new Error('Legacy safety descriptor checksum mismatch');
  const manifest = legacySafetySnapshotSchema.parse(raw);
  if (basename(directory) !== manifest.id || manifest.candidate.releaseId !== 'commerce' || manifest.candidate.version === '0.1.0') throw new Error('Legacy safety identity mismatch');
  if (catalogDigest(validateLegacyB01Directory(manifest.source.directory)) !== catalogDigest(manifest.source)
    || catalogDigest(validateReleaseDirectory(manifest.candidate.directory, 'commerce')) !== catalogDigest(manifest.candidate)) throw new Error('Legacy safety recovery artifact changed');
  const dump = join(directory, manifest.dump.file);
  await verifyPrivateDump(dump, manifest.dump);
  return { directory, manifest, manifestChecksum: expectedChecksum, dump };
}
