import { catalogDigest } from '@storeweave/db';
import { inspectCutover, cutOverOrRecognize } from './database-cutover';
import { parsePgUrl } from './pg-tool';
import { readRestoreJournal, writeRestoreJournal } from './restore-journal';
import { verifyLegacySafetyDatabase, verifyLegacyRestoredDatabase, verifyRestoredDatabase } from './verify-restored-database';
import { verifyLegacySafetyRuntime, verifyLegacySourceRuntime, verifySourceRuntime } from './verify-source-runtime';
import type { LegacyMigrationBaseline } from '@storeweave/db';

/** Caller holds the local transition lock and has stopped managed/external writers. Never drops retained databases. */
export async function resumeRestoreCutover(recorded: Awaited<ReturnType<typeof readRestoreJournal>>, maintenanceUrl: string, configFile: string, lockFd?: number, baseline?: LegacyMigrationBaseline) {
  const { file, operationRoot, journal, snapshot } = recorded;
  if (!['restored', 'cutover-intent', 'cutover-committed'].includes(journal.phase) || !journal.scratch.oid) {
    throw new Error('Restore has no completed scratch database; preserve this attempt and create a new scratch');
  }
  const intent = { systemIdentifier: journal.systemIdentifier, live: journal.live,
    scratch: { name: journal.scratch.name, oid: journal.scratch.oid }, quarantineName: journal.quarantineName };
  const url = parsePgUrl(maintenanceUrl);
  url.port = url.port || process.env.PGPORT || '5432';
  if (catalogDigest({ host: url.hostname, port: url.port, database: journal.live.name }) !== snapshot.manifest.endpointChecksum) throw new Error('Snapshot endpoint mismatch');
  const mapping = await inspectCutover(url.toString(), intent);
  if (mapping === 'already-committed' && !['cutover-intent', 'cutover-committed'].includes(journal.phase)) {
    throw new Error('Committed database mapping has no durable cutover intent');
  }
  if (mapping === 'ready' && journal.phase === 'cutover-committed') throw new Error('Committed restore journal has an initial database mapping');
  const verify = async (name: string) => {
    const target = new URL(url);
    target.pathname = `/${encodeURIComponent(name)}`;
    if (journal.kind === 'legacy-b01-safety-restore') {
      await verifyLegacySafetyDatabase(snapshot.directory, journal.snapshot.checksum, target.toString(), intent.scratch.oid);
      await verifyLegacySafetyRuntime(snapshot.directory, journal.snapshot.checksum, configFile, target.toString(), lockFd);
      await verifyLegacySafetyDatabase(snapshot.directory, journal.snapshot.checksum, target.toString(), intent.scratch.oid);
    } else if (journal.kind === 'legacy-b01-restore') {
      if (!baseline) throw new Error('Legacy restore requires the selected release baseline');
      await verifyLegacyRestoredDatabase(snapshot.directory, journal.snapshot.checksum, target.toString(), intent.scratch.oid, baseline);
      await verifyLegacySourceRuntime(snapshot.directory, journal.snapshot.checksum, configFile, target.toString(), baseline, lockFd);
      await verifyLegacyRestoredDatabase(snapshot.directory, journal.snapshot.checksum, target.toString(), intent.scratch.oid, baseline);
    } else {
      await verifyRestoredDatabase(snapshot.directory, journal.snapshot.checksum, target.toString(), intent.scratch.oid);
      await verifySourceRuntime(snapshot.directory, journal.snapshot.checksum, configFile, target.toString(), lockFd);
      await verifyRestoredDatabase(snapshot.directory, journal.snapshot.checksum, target.toString(), intent.scratch.oid);
    }
  };
  if (mapping === 'ready') {
    await verify(intent.scratch.name);
    writeRestoreJournal(file, { ...journal, phase: 'cutover-intent' }, operationRoot);
    await cutOverOrRecognize(url.toString(), intent);
  }
  // A crash after PostgreSQL COMMIT is recovered from the OID mapping, even if this write never happened.
  writeRestoreJournal(file, { ...journal, phase: 'cutover-committed' }, operationRoot);
  await verify(intent.live.name);
  return { sourceDirectory: snapshot.manifest.source.directory, journalFile: file, quarantineName: intent.quarantineName };
}
