import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Client } from 'pg';
import { z } from 'zod';
import { catalogDigest, readSnapshotDatabase, type ReleaseSnapshot } from '@storeweave/db';
import { parsePgUrl } from './pg-tool';
import { assertJournalLocation, readPairedSnapshot, readPrivateJson, writePrivateJson } from './read-release-snapshot';

const schema = z.object({ schemaVersion: z.literal(1), kind: z.literal('upgrade'), id: z.string().uuid(),
  phase: z.enum(['prepared', 'migrating', 'migrated', 'activated']),
  snapshot: z.object({ directory: z.string().refine(isAbsolute), checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
}).strict();

/** Caller holds the transition lock and provides its already durable private operation root. */
export async function createUpgradeJournal(root: string, directory: string, checksum: string) {
  const parent = lstatSync(root);
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.geteuid?.()) throw new Error('Upgrade journal root must be an owned 0700 directory');
  const pair = await readPairedSnapshot(directory, checksum);
  const id = randomUUID();
  const home = join(resolve(root), id);
  mkdirSync(home, { mode: 0o700 });
  const file = join(home, 'upgrade.json');
  writeUpgradeJournal(file, { schemaVersion: 1, kind: 'upgrade', id, phase: 'prepared',
    snapshot: { directory: pair.directory, checksum } }, root);
  return file;
}

export async function readUpgradeJournal(file: string, operationRoot: string) {
  file = resolve(file);
  assertJournalLocation(file, operationRoot);
  const journal = schema.parse(readPrivateJson(file));
  if (basename(file) !== 'upgrade.json' || basename(dirname(file)) !== journal.id) throw new Error('Upgrade journal identity mismatch');
  const snapshot = await readPairedSnapshot(journal.snapshot.directory, journal.snapshot.checksum);
  return { file, operationRoot: resolve(operationRoot), journal, snapshot };
}

export function writeUpgradeJournal(file: string, value: z.infer<typeof schema>, operationRoot: string) {
  assertJournalLocation(file, operationRoot);
  writePrivateJson(file, schema.parse(value));
}

/** Partial migration history is allowed on forward retry; replacing the live physical database is not. */
export async function requireUpgradeDatabase(pair: { manifest: { evidence: { database: Pick<ReleaseSnapshot['database'], 'name' | 'oid' | 'systemIdentifier'> }; endpointChecksum: string } }, databaseUrl: string) {
  const url = parsePgUrl(databaseUrl);
  url.port = url.port || process.env.PGPORT || '5432';
  const expected = pair.manifest.evidence.database;
  if (decodeURIComponent(url.pathname.slice(1)) !== expected.name
    || catalogDigest({ host: url.hostname, port: url.port, database: expected.name }) !== pair.manifest.endpointChecksum) throw new Error('Upgrade database endpoint mismatch');
  const client = new Client({ connectionString: url.toString() });
  try {
    await client.connect();
    const actual = await readSnapshotDatabase(client);
    if (actual.systemIdentifier !== expected.systemIdentifier || actual.oid !== expected.oid || actual.name !== expected.name) {
      throw new Error('Upgrade database identity differs from its source snapshot');
    }
  } finally { await client.end(); }
}
