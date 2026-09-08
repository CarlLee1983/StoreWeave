import { readLegacySafetySnapshot } from './legacy-safety-snapshot';
import { parsePgUrl } from './pg-tool';
import { Client } from 'pg';
import { catalogDigest, readLegacySafetyHistory, readSnapshotDatabase, readSnapshotHistory } from '@storeweave/db';
import { readLegacyPairedSnapshot } from './legacy-paired-snapshot';
import { readPairedSnapshot } from './read-release-snapshot';

/** Point-in-time database verification; caller must keep writers stopped and run the retained source runtime check. */
export async function verifyRestoredDatabase(directory: string, checksum: string, databaseUrl: string, expectedOid: string) {
  return verifySnapshotDatabase(await readPairedSnapshot(directory, checksum), databaseUrl, expectedOid);
}

/** Legacy rollback also binds the complete adoption record retained in the source dump. */
export async function verifyLegacyRestoredDatabase(directory: string, checksum: string, databaseUrl: string, expectedOid: string) {
  return verifySnapshotDatabase(await readLegacyPairedSnapshot(directory, checksum), databaseUrl, expectedOid);
}

/** Raw recovery restores the pre-adoption ledger without synthesizing release history. */
export async function verifyLegacySafetyDatabase(directory: string, checksum: string, databaseUrl: string, expectedOid: string) {
  return verifySnapshotDatabase(await readLegacySafetySnapshot(directory, checksum), databaseUrl, expectedOid);
}

async function verifySnapshotDatabase(pair: Awaited<ReturnType<typeof readPairedSnapshot>> | Awaited<ReturnType<typeof readLegacyPairedSnapshot>> | Awaited<ReturnType<typeof readLegacySafetySnapshot>>,
  databaseUrl: string, expectedOid: string) {
  const expected = pair.manifest.evidence;
  let url: URL;
  try { url = parsePgUrl(databaseUrl); } catch { throw new Error('Invalid verification database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') throw new Error('Verification requires an explicit PostgreSQL endpoint');
  url.port = url.port || process.env.PGPORT || '5432';
  if (catalogDigest({ host: url.hostname, port: url.port, database: expected.database.name }) !== pair.manifest.endpointChecksum) throw new Error('Snapshot verification endpoint mismatch');
  const client = new Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL search_path = pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'");
      const actual = await readSnapshotDatabase(client);
      if (actual.oid !== expectedOid || actual.systemIdentifier !== expected.database.systemIdentifier
        || !/^17(?:\.|$)/.test(actual.serverVersion) || !/^17(?:\.|$)/.test(expected.database.serverVersion)
        || catalogDigest(actual.properties) !== catalogDigest(expected.database.properties)) throw new Error('Restored database identity or properties mismatch');
      if ('historyChecksum' in expected) {
        const history = await readSnapshotHistory(client);
        if (history.migrationsChecksum !== expected.migrationsChecksum || history.historyChecksum !== expected.historyChecksum
          || catalogDigest(history.historySequence) !== catalogDigest(expected.historySequence)) throw new Error('Restored database history mismatch');
      } else if (await readLegacySafetyHistory(client) !== expected.migrationsChecksum) {
        throw new Error('Restored raw migration history mismatch');
      }
      if ('baseline' in pair.manifest) {
        const saved = pair.manifest.baseline;
        const result = await client.query<{ entry: Record<string, unknown> }>(`SELECT pg_catalog.to_jsonb(b) AS entry
          FROM public.platform_release_history r JOIN public.platform_migration_baselines b ON b.id = r.legacy_baseline_id
          WHERE r.sequence = $1 AND b.id = $2`, [pair.manifest.evidence.release.sequence, saved.id]);
        const entry = result.rows[0]?.entry;
        if (result.rows.length !== 1 || !entry || entry.catalog_id !== saved.catalogId || entry.catalog_checksum !== saved.catalogChecksum || entry.evidence !== saved.evidence
          || entry.historical_sql_verified !== false || entry.historical_runtime_verified !== false
          || catalogDigest(entry) !== saved.checksum) throw new Error('Restored legacy baseline provenance mismatch');
      }
      await client.query('COMMIT');
      return { name: actual.name, oid: actual.oid, systemIdentifier: actual.systemIdentifier };
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Database verification and transaction cleanup failed'); }
      throw error;
    }
  } finally { await client.end(); }
}
