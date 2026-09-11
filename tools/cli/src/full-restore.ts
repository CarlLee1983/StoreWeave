import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { catalogDigest, readSnapshotDatabase, readSnapshotHistory } from '@storeweave/db';
import { buildReleaseManifest } from '../../../packages/platform/bundle/src/release-manifest';
import { bootstrapRelease } from '@storeweave/bootstrap-release';
import { release } from '@storeweave/selected-release';
import type { BaseConfig } from '@storeweave/config';
import { cutOverEmptyOrRecognize, cutOverOrRecognize } from './database-cutover';
import { restoreDumpToScratch } from './database-scratch';
import { fullRecoveryJournalSchema, readFullRecoveryJournal, writeFullRecoveryJournal, type FullRecoveryJournal } from './full-recovery-journal';
import { parsePgUrl } from './pg-tool';
import { readPrivateJson, verifyPrivateDump } from './read-release-snapshot';
import { assertStorageBackupMatchesDatabase, fullBackupSchema, readStorageBackupCatalog, restoreStorageBackup, type FullBackup, type StorageBackup } from './storage-backup';

interface VerifiedBundle {
  readonly directory: string;
  readonly manifest: FullBackup;
  readonly manifestChecksum: string;
  readonly storage: StorageBackup;
}

export async function runFullRestore(input: {
  readonly bundleDirectory: string;
  readonly operationRoot: string;
  readonly maintenanceUrl: string;
  readonly configFile: string;
  readonly config: BaseConfig;
  readonly lockFd?: number;
  readonly resumeJournal?: string;
}): Promise<{ journalFile: string; quarantineName: string | null; objects: number }> {
  const bundle = await readFullBundle(input.bundleDirectory);
  assertCompiledRelease(bundle.manifest);
  const liveName = databaseName(input.config.database.url);
  const maintenance = parsePgUrl(input.maintenanceUrl);
  maintenance.port = maintenance.port || process.env.PGPORT || '5432';
  if (databaseName(maintenance.toString()) === liveName) throw new Error('Maintenance database must differ from the recovery live database');

  let record: ReturnType<typeof readFullRecoveryJournal>;
  if (input.resumeJournal) {
    record = readFullRecoveryJournal(input.resumeJournal, input.operationRoot);
    assertBundleMatchesJournal(bundle, record.journal);
    if (record.journal.target.live.name !== liveName) throw new Error('Full recovery journal is for a different configured live database');
  } else {
    const target = await inspectTarget(maintenance.toString(), liveName);
    const id = randomUUID();
    const home = join(resolve(input.operationRoot), id);
    mkdirSync(home, { mode: 0o700 });
    const file = join(home, 'journal.json');
    const journal = fullRecoveryJournalSchema.parse({
      schemaVersion: 1, kind: 'full-recovery', id, phase: 'planned',
      bundle: { directory: bundle.directory, manifestChecksum: bundle.manifestChecksum, storageChecksum: bundle.manifest.storage.sha256, objectCount: bundle.storage.objects.length },
      target: { systemIdentifier: target.systemIdentifier, live: { name: liveName, oid: target.liveOid } },
      scratch: { name: `storeweave_full_recovery_${id.replaceAll('-', '')}`, oid: null },
      quarantineName: target.liveOid === null ? null : `storeweave_retained_${id.replaceAll('-', '')}`,
    });
    writeFullRecoveryJournal(file, journal, input.operationRoot);
    record = readFullRecoveryJournal(file, input.operationRoot);
  }

  const target = await inspectTarget(maintenance.toString(), liveName);
  if (target.systemIdentifier !== record.journal.target.systemIdentifier || target.liveOid !== record.journal.target.live.oid) {
    const committed = record.journal.scratch.oid !== null && target.liveOid === record.journal.scratch.oid
      && ['cutover-intent', 'cutover-committed', 'verified'].includes(record.journal.phase);
    if (!committed) throw new Error('Target cluster or initial live database mapping differs from the full recovery journal');
  }

  if (record.journal.phase === 'planned') {
    const scratch = await restoreDumpToScratch({
      maintenanceUrl: maintenance.toString(), liveName, source: bundle.manifest.evidence.database,
      dump: join(bundle.directory, bundle.manifest.database.file), lockFd: input.lockFd,
      namePrefix: 'storeweave_full_recovery_', id: record.journal.id,
      onCreated: created => writeFullRecoveryJournal(record.file, { ...record.journal, phase: 'scratch-created',
        target: { systemIdentifier: created.systemIdentifier, live: { name: liveName, oid: created.targetOid } },
        scratch: { name: created.name, oid: created.oid } }, record.operationRoot),
    });
    record = readFullRecoveryJournal(record.file, record.operationRoot);
    await verifyFullDatabase(scratch.name, maintenance.toString(), bundle.manifest, scratch.oid);
    writeFullRecoveryJournal(record.file, { ...record.journal, phase: 'database-restored' }, record.operationRoot);
    record = readFullRecoveryJournal(record.file, record.operationRoot);
  }
  if (record.journal.phase === 'scratch-created') {
    throw new Error('Scratch database creation was recorded but its dump did not finish; preserve it for diagnosis and start a new recovery');
  }
  if (!record.journal.scratch.oid) throw new Error('Full recovery journal has no scratch database');
  const scratchOid = record.journal.scratch.oid;

  if (record.journal.phase === 'database-restored') {
    await restoreAndVerifyMedia(input, maintenance.toString(), record.journal.scratch.name, bundle);
    await verifyFullDatabase(record.journal.scratch.name, maintenance.toString(), bundle.manifest, scratchOid);
    writeFullRecoveryJournal(record.file, { ...record.journal, phase: 'media-restored' }, record.operationRoot);
    record = readFullRecoveryJournal(record.file, record.operationRoot);
  }

  if (record.journal.phase === 'media-restored') {
    await restoreAndVerifyMedia(input, maintenance.toString(), record.journal.scratch.name, bundle);
    await verifyFullDatabase(record.journal.scratch.name, maintenance.toString(), bundle.manifest, scratchOid);
    writeFullRecoveryJournal(record.file, { ...record.journal, phase: 'cutover-intent' }, record.operationRoot);
    record = readFullRecoveryJournal(record.file, record.operationRoot);
  }
  if (record.journal.phase === 'cutover-intent') {
    if (record.journal.target.live.oid === null) {
      await cutOverEmptyOrRecognize(maintenance.toString(), { systemIdentifier: record.journal.target.systemIdentifier,
        liveName, scratch: { name: record.journal.scratch.name, oid: scratchOid } });
    } else {
      await cutOverOrRecognize(maintenance.toString(), { systemIdentifier: record.journal.target.systemIdentifier,
        live: { name: liveName, oid: record.journal.target.live.oid }, scratch: { name: record.journal.scratch.name, oid: scratchOid },
        quarantineName: record.journal.quarantineName! });
    }
    writeFullRecoveryJournal(record.file, { ...record.journal, phase: 'cutover-committed' }, record.operationRoot);
    record = readFullRecoveryJournal(record.file, record.operationRoot);
  }
  if (record.journal.phase === 'cutover-committed') {
    await restoreAndVerifyMedia(input, maintenance.toString(), liveName, bundle);
    await verifyFullDatabase(liveName, maintenance.toString(), bundle.manifest, scratchOid);
    writeFullRecoveryJournal(record.file, { ...record.journal, phase: 'verified' }, record.operationRoot);
    record = readFullRecoveryJournal(record.file, record.operationRoot);
  }
  if (record.journal.phase !== 'verified') throw new Error('Full recovery did not reach a verified terminal phase');
  return { journalFile: record.file, quarantineName: record.journal.quarantineName, objects: bundle.storage.objects.length };
}

async function readFullBundle(directory: string): Promise<VerifiedBundle> {
  directory = resolve(directory);
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error(`Full backup bundle must be a private real directory: ${directory}`);
  const raw = readPrivateJson(join(directory, 'manifest.json'));
  const manifest = fullBackupSchema.parse(raw);
  if (manifest.release.id !== manifest.evidence.release.releaseId || manifest.release.version !== manifest.evidence.release.releaseVersion
    || manifest.release.buildManifestChecksum !== manifest.evidence.release.buildManifestChecksum) throw new Error('Full backup release evidence mismatch');
  await verifyPrivateDump(join(directory, manifest.database.file), { bytes: manifest.database.byteSize, checksum: manifest.database.sha256 });
  const storage = await readStorageBackupCatalog(directory, manifest.storage);
  return { directory, manifest, manifestChecksum: catalogDigest(manifest), storage };
}

function assertCompiledRelease(manifest: FullBackup): void {
  const expected = { id: release.id, version: release.version, buildManifestChecksum: catalogDigest(buildReleaseManifest(release)) };
  if (catalogDigest(manifest.release) !== catalogDigest(expected)) throw new Error('Full backup release identity does not match this running release');
}

function assertBundleMatchesJournal(bundle: VerifiedBundle, journal: FullRecoveryJournal): void {
  if (catalogDigest({ directory: bundle.directory, manifestChecksum: bundle.manifestChecksum, storageChecksum: bundle.manifest.storage.sha256, objectCount: bundle.storage.objects.length })
    !== catalogDigest(journal.bundle)) throw new Error('Full recovery journal does not match the supplied bundle');
}

function databaseName(urlValue: string): string {
  const url = parsePgUrl(urlValue);
  if (!url.hostname || !url.pathname || url.pathname === '/') throw new Error('Full recovery requires an explicit PostgreSQL endpoint');
  return decodeURIComponent(url.pathname.slice(1));
}

async function inspectTarget(maintenanceUrl: string, liveName: string): Promise<{ systemIdentifier: string; liveOid: string | null }> {
  const client = new Client({ connectionString: maintenanceUrl });
  try {
    await client.connect();
    const systemIdentifier = (await client.query<{ system_identifier: string }>('SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()')).rows[0]!.system_identifier;
    const live = (await client.query<{ oid: string }>('SELECT oid::pg_catalog.text FROM pg_catalog.pg_database WHERE datname = $1', [liveName])).rows[0];
    return { systemIdentifier, liveOid: live?.oid ?? null };
  } finally { await client.end(); }
}

async function restoreAndVerifyMedia(input: Parameters<typeof runFullRestore>[0], maintenanceUrl: string, database: string, bundle: VerifiedBundle): Promise<void> {
  const directory = mkdtempSync(join(resolve(input.operationRoot), '.full-restore-config-'));
  const url = new URL(maintenanceUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  const configFile = join(directory, 'config.json');
  try {
    writeFileSync(configFile, JSON.stringify({ ...input.config, database: { ...input.config.database, url: url.toString() } }), { flag: 'wx', mode: 0o600 });
    const boot = await bootstrapRelease(release, { configPath: configFile, loggerName: `${release.id}-full-restore`, logDestination: 'stderr' });
    try {
      await boot.runtime.activateRelease('require-current');
      await assertStorageBackupMatchesDatabase(boot.runtime, bundle.storage);
      await restoreStorageBackup(boot.runtime, bundle.directory, bundle.storage);
      await assertStorageBackupMatchesDatabase(boot.runtime, bundle.storage);
    } finally { await boot.runtime.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function verifyFullDatabase(name: string, maintenanceUrl: string, manifest: FullBackup, expectedOid: string): Promise<void> {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${encodeURIComponent(name)}`;
  const client = new Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL search_path = pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'");
      const actual = await readSnapshotDatabase(client);
      const expected = manifest.evidence;
      if (actual.oid !== expectedOid || !/^17(?:\.|$)/.test(actual.serverVersion) || !/^17(?:\.|$)/.test(expected.database.serverVersion)) {
        throw new Error('Full recovery database identity mismatch');
      }
      if (catalogDigest(actual.properties) !== catalogDigest(expected.database.properties)) throw new Error('Full recovery database properties mismatch');
      const history = await readSnapshotHistory(client);
      if (history.migrationsChecksum !== expected.migrationsChecksum || history.historyChecksum !== expected.historyChecksum
        || catalogDigest(history.historySequence) !== catalogDigest(expected.historySequence)) throw new Error('Full recovery database history mismatch');
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Full recovery verification and cleanup failed'); }
      throw error;
    }
  } finally { await client.end(); }
}
