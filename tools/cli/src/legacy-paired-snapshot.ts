import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { catalogDigest, legacyBaselineSelection, withReleaseSnapshot, type MigrationSet } from '@storeweave/db';
import baseline from '../../../packages/platform/bundle/src/legacy/commerce-pre-b02.json';
import { legacySafetySnapshotSchema, readLegacySafetySnapshot } from './legacy-safety-snapshot';
import { pairedSnapshotSchema, readPrivateJson, verifyPrivateDump, writePrivateJson } from './read-release-snapshot';
import { parsePgUrl, writePgBackup } from './pg-tool';

const schema = pairedSnapshotSchema.extend({ kind: z.literal('legacy-b01-paired'),
  source: legacySafetySnapshotSchema.shape.source,
  safety: z.object({ directory: z.string().refine(isAbsolute), checksum: pairedSnapshotSchema.shape.endpointChecksum }).strict(),
  baseline: z.object({ id: z.string().uuid(), catalogId: z.literal('legacy-commerce-0.1.0-pre-b02'),
    evidence: z.string().min(1), catalogChecksum: pairedSnapshotSchema.shape.endpointChecksum, checksum: pairedSnapshotSchema.shape.endpointChecksum,
    historicalSqlVerified: z.literal(false), historicalRuntimeVerified: z.literal(false) }).strict(),
}).strict();

/** Caller has adopted the fixed baseline and holds the operation lock with all writers stopped. */
export async function createLegacyPairedSnapshot(pool: Pool, sets: readonly MigrationSet[], options: {
  databaseUrl: string; safetyDirectory: string; safetyChecksum: string; operationRoot: string;
  evidence: string; enabledExtensions?: readonly string[]; lockFd?: number;
}) {
  const safety = await readLegacySafetySnapshot(options.safetyDirectory, options.safetyChecksum);
  const root = resolve(options.operationRoot), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('Legacy pair root must be owned and 0700');
  const url = parsePgUrl(options.databaseUrl);
  url.port = url.port || process.env.PGPORT || '5432';
  const expected = safety.manifest.evidence.database;
  if (catalogDigest({ host: url.hostname, port: url.port, database: decodeURIComponent(url.pathname.slice(1)) }) !== safety.manifest.endpointChecksum) throw new Error('Legacy pair endpoint mismatch');
  const source = legacyBaselineSelection(baseline, sets, options.enabledExtensions);
  const catalogChecksum = catalogDigest({ id: baseline.id, sourceRelease: baseline.sourceRelease, manifest: source.manifest });
  const staging = mkdtempSync(join(root, '.legacy-pair-')), id = randomUUID(), destination = join(root, id);
  try {
    const manifest = await withReleaseSnapshot(pool, source.selection, source.migrations, async (captured, client) => {
      if (captured.database.oid !== expected.oid || captured.database.systemIdentifier !== expected.systemIdentifier
        || catalogDigest(captured.database) !== catalogDigest(expected)) throw new Error('Legacy pair database differs from raw safety snapshot');
      const provenance = await client.query<{ id: string; entry: Record<string, unknown> }>(`SELECT b.id, pg_catalog.to_jsonb(b) AS entry
        FROM public.platform_release_history r JOIN public.platform_migration_baselines b ON b.id = r.legacy_baseline_id
        WHERE r.sequence = $1 AND b.catalog_id = $2 AND b.catalog_checksum = $3 AND b.source_release = $4
          AND b.historical_sql_verified = false AND b.historical_runtime_verified = false`,
      [captured.release.sequence, baseline.id, catalogChecksum, baseline.sourceRelease]);
      if (provenance.rows.length !== 1) throw new Error('Legacy pair requires exact unverified baseline provenance');
      const baselineEntry = provenance.rows[0]!.entry;
      if (typeof baselineEntry.evidence !== 'string' || !baselineEntry.evidence.trim()
        || baselineEntry.evidence !== options.evidence.trim()
        || typeof baselineEntry.accepted_at !== 'string' || !Number.isFinite(Date.parse(baselineEntry.accepted_at))) throw new Error('Legacy baseline evidence is incomplete');
      const original = await client.query<{ entries: Record<string, unknown>[] }>(`SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY id), '[]'::pg_catalog.jsonb) AS entries
        FROM public.platform_migrations m`);
      const rows = original.rows[0]!.entries;
      if (catalogDigest(rows.map(({ id, phase, applied_at }) => ({ id, phase, applied_at }))) !== safety.manifest.evidence.migrationsChecksum) throw new Error('Legacy migration history differs from raw safety snapshot');
      for (const row of rows) {
        const owner = source.manifest.owners.map(entry => entry.owner).find(owner => owner.kind === 'module'
          && typeof row.id === 'string' && row.id.startsWith(`${owner.migrationOwner}/`));
        if (!owner || owner.kind !== 'module' || typeof row.id !== 'string') throw new Error('Legacy migration owner is not pinned');
        const expected = { legacy_baseline_id: provenance.rows[0]!.id, migration_owner: owner.migrationOwner,
          migration_id: row.id.slice(owner.migrationOwner!.length + 1), module_id: owner.id, module_version: owner.version,
          release_id: source.manifest.releaseId, release_version: source.manifest.releaseVersion };
        if (Object.entries(expected).some(([key, value]) => row[key] !== value)) throw new Error('Legacy migration baseline association or provenance differs');
      }
      const dump = join(staging, 'database.dump');
      await writePgBackup(url.toString(), dump, captured.snapshotId, options.lockFd);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(dump)) hash.update(chunk);
      await readLegacySafetySnapshot(safety.directory, options.safetyChecksum);
      const { snapshotId: _transient, ...evidence } = captured;
      const value = schema.parse({ schemaVersion: 1, kind: 'legacy-b01-paired', id, createdAt: new Date().toISOString(),
        source: safety.manifest.source, candidate: safety.manifest.candidate, endpointChecksum: safety.manifest.endpointChecksum,
        safety: { directory: safety.directory, checksum: options.safetyChecksum }, evidence,
        baseline: { id: provenance.rows[0]!.id, catalogId: baseline.id, evidence: baselineEntry.evidence, catalogChecksum, checksum: catalogDigest(provenance.rows[0]!.entry), historicalSqlVerified: false, historicalRuntimeVerified: false },
        dump: { file: 'database.dump', bytes: statSync(dump).size, checksum: hash.digest('hex') } });
      writePrivateJson(join(staging, 'snapshot.json'), value);
      return value;
    });
    await readLegacySafetySnapshot(safety.directory, options.safetyChecksum);
    mkdirSync(destination, { mode: 0o700 });
    renameSync(staging, destination);
    const fd = openSync(root, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return { directory: destination, manifest, manifestChecksum: catalogDigest(manifest) };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Both immutable dumps and both release trees remain required recovery inputs. */
export async function readLegacyPairedSnapshot(directory: string, expectedChecksum: string) {
  directory = resolve(directory);
  const raw = readPrivateJson(join(directory, 'snapshot.json'));
  if (catalogDigest(raw) !== expectedChecksum) throw new Error('Legacy pair descriptor checksum mismatch');
  const manifest = schema.parse(raw);
  const safety = await readLegacySafetySnapshot(manifest.safety.directory, manifest.safety.checksum);
  if (basename(directory) !== manifest.id || catalogDigest(manifest.source) !== catalogDigest(safety.manifest.source)
    || catalogDigest(manifest.candidate) !== catalogDigest(safety.manifest.candidate)
    || manifest.endpointChecksum !== safety.manifest.endpointChecksum
    || catalogDigest(manifest.evidence.database) !== catalogDigest(safety.manifest.evidence.database)
    || manifest.evidence.release.releaseId !== 'commerce' || manifest.evidence.release.releaseVersion !== '0.1.0'
    || manifest.evidence.release.buildManifestChecksum !== baseline.manifest.buildManifestChecksum) throw new Error('Legacy pair identity mismatch');
  const dump = join(directory, manifest.dump.file);
  await verifyPrivateDump(dump, manifest.dump);
  return { directory, manifest, manifestChecksum: expectedChecksum, dump, safety };
}
