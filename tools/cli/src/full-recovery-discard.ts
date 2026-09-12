import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, escapeIdentifier as ident } from 'pg';
import type { BaseConfig } from '@storeweave/config';
import { withStagedRuntime } from './full-restore';
import { readFullRecoveryJournal, readRestoredKeys } from './full-recovery-journal';
import { parsePgUrl } from './pg-tool';

/**
 * A full recovery that stops before its cutover leaves two things behind: a
 * scratch database on the target cluster, and the storage objects its media
 * replay published into the live object store. Neither is reachable from the
 * recovered system, and reattempting the recovery creates a fresh pair. This
 * module is how an operator lists and reclaims them.
 *
 * A committed cutover is never discardable: the scratch database has become
 * the live one, so dropping it would destroy the recovered deployment.
 */
const DISCARDABLE = ['planned', 'scratch-created', 'database-restored', 'media-restored', 'cutover-intent', 'failed'];

export interface FullRecoverySummary {
  readonly journalFile: string;
  readonly id: string;
  readonly phase: string;
  readonly scratchName: string;
  readonly scratchExists: boolean;
  readonly quarantineName: string | null;
  readonly restoredObjects: number;
  readonly discardable: boolean;
}

export async function listFullRecoveries(operationRoot: string, maintenanceUrl: string): Promise<readonly FullRecoverySummary[]> {
  const root = resolve(operationRoot);
  const summaries: FullRecoverySummary[] = [];
  const client = new Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(root, entry.name, 'journal.json');
      let record: ReturnType<typeof readFullRecoveryJournal>;
      // Sibling journals of other kinds share this root; skipping them is not
      // an error, and a journal this release cannot read is not ours to report.
      try { record = readFullRecoveryJournal(file, root); } catch { continue; }
      const scratch = await databaseOid(client, record.journal.scratch.name);
      summaries.push({
        journalFile: record.file, id: record.journal.id, phase: record.journal.phase,
        scratchName: record.journal.scratch.name, scratchExists: scratch !== null,
        quarantineName: record.journal.quarantineName, restoredObjects: record.journal.restored?.count ?? 0,
        discardable: DISCARDABLE.includes(record.journal.phase),
      });
    }
  } finally { await client.end(); }
  return summaries;
}

export async function discardFullRecovery(input: {
  readonly journalFile: string;
  readonly operationRoot: string;
  readonly maintenanceUrl: string;
  readonly config: BaseConfig;
}): Promise<{ droppedScratch: boolean; removedObjects: number }> {
  const record = readFullRecoveryJournal(input.journalFile, input.operationRoot);
  const journal = record.journal;
  if (!DISCARDABLE.includes(journal.phase)) throw new Error(`A full recovery in phase "${journal.phase}" is not discardable`);
  const liveName = databaseName(input.config.database.url);
  if (journal.target.live.name !== liveName) throw new Error('Full recovery journal is for a different configured live database');
  if (journal.scratch.name === liveName) throw new Error('Full recovery journal names the live database as its scratch database');

  const client = new Client({ connectionString: input.maintenanceUrl });
  await client.connect();
  let scratchOid: string | null;
  try {
    const systemIdentifier = (await client.query<{ system_identifier: string }>(
      'SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()')).rows[0]!.system_identifier;
    if (systemIdentifier !== journal.target.systemIdentifier) throw new Error('Full recovery journal belongs to a different cluster');
    const liveOid = await databaseOid(client, liveName);
    // The cutover renames the scratch database to the live name. If that has
    // already happened the recovery is live, whatever the journal last recorded.
    if (liveOid !== null && journal.scratch.oid !== null && liveOid === journal.scratch.oid) {
      throw new Error('This recovery is already the live database; it cannot be discarded');
    }
    scratchOid = await databaseOid(client, journal.scratch.name);
    if (scratchOid !== null && journal.scratch.oid !== null && scratchOid !== journal.scratch.oid) {
      throw new Error('A different database now holds the scratch name; refusing to drop it');
    }
  } finally { await client.end(); }

  // Objects first: the scratch database is what makes the key list meaningful,
  // so it must outlive the deletion it authorises.
  let removedObjects = 0;
  if (journal.restored && journal.restored.count > 0) {
    if (scratchOid === null) throw new Error('This recovery published storage objects but its scratch database is gone; reclaim the objects by hand');
    const keys = readRestoredKeys(record.file, journal.restored, record.operationRoot);
    removedObjects = await withStagedRuntime({ operationRoot: input.operationRoot, config: input.config,
      maintenanceUrl: input.maintenanceUrl, database: journal.scratch.name },
    runtime => runtime.storage.discardRestored(keys));
  }

  let droppedScratch = false;
  if (scratchOid !== null) {
    const drop = new Client({ connectionString: input.maintenanceUrl });
    await drop.connect();
    try {
      await drop.query(`DROP DATABASE ${ident(journal.scratch.name)} WITH (FORCE)`);
      droppedScratch = true;
    } finally { await drop.end(); }
  }

  rmSync(resolve(record.file, '..'), { recursive: true, force: true });
  return { droppedScratch, removedObjects };
}

async function databaseOid(client: Client, name: string): Promise<string | null> {
  const found = await client.query<{ oid: string }>('SELECT oid::pg_catalog.text FROM pg_catalog.pg_database WHERE datname = $1', [name]);
  return found.rows[0]?.oid ?? null;
}

function databaseName(urlValue: string): string {
  const url = parsePgUrl(urlValue);
  if (!url.hostname || !url.pathname || url.pathname === '/') throw new Error('Full recovery requires an explicit PostgreSQL endpoint');
  return decodeURIComponent(url.pathname.slice(1));
}
