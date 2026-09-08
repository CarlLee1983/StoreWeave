import { readLegacySafetySnapshot } from './legacy-safety-snapshot';
import { readLegacyPairedSnapshot } from './legacy-paired-snapshot';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { assertJournalLocation, readPairedSnapshot, readPrivateJson, writePrivateJson } from './read-release-snapshot';

const oid = z.string().regex(/^[1-9]\d*$/);
const databaseName = z.string().min(1).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 63);
const schema = z.object({ schemaVersion: z.literal(1), kind: z.enum(['restore', 'legacy-b01-restore', 'legacy-b01-safety-restore']), id: z.string().uuid(),
  phase: z.enum(['planned', 'created', 'restored', 'cutover-intent', 'cutover-committed', 'failed']),
  snapshot: z.object({ directory: z.string().refine(isAbsolute), checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  systemIdentifier: oid, live: z.object({ name: databaseName, oid }).strict(),
  scratch: z.object({ name: databaseName, oid: oid.nullable() }).strict(), quarantineName: databaseName,
}).strict();

/** Phase is progress evidence only; recovery must inspect actual database OIDs before any write. */
export async function readRestoreJournal(file: string, operationRoot: string) {
  file = resolve(file);
  assertJournalLocation(file, operationRoot);
  const journal = schema.parse(readPrivateJson(file));
  const suffix = journal.id.replaceAll('-', '');
  if (basename(file) !== 'journal.json' || basename(dirname(file)) !== journal.id
    || journal.scratch.name !== `storeweave_restore_${suffix}` || journal.quarantineName !== `storeweave_retained_${suffix}`
    || new Set([journal.live.name, journal.scratch.name, journal.quarantineName]).size !== 3
    || journal.live.oid === journal.scratch.oid
    || (journal.phase === 'planned' && journal.scratch.oid !== null)
    || (['created', 'restored', 'cutover-intent', 'cutover-committed'].includes(journal.phase) && journal.scratch.oid === null)) throw new Error('Restore journal identity mismatch');
  const readSnapshot = journal.kind === 'legacy-b01-safety-restore' ? readLegacySafetySnapshot : journal.kind === 'legacy-b01-restore' ? readLegacyPairedSnapshot : readPairedSnapshot;
  const snapshot = await readSnapshot(journal.snapshot.directory, journal.snapshot.checksum);
  const database = snapshot.manifest.evidence.database;
  if (journal.systemIdentifier !== database.systemIdentifier || journal.live.name !== database.name || journal.live.oid !== database.oid) {
    throw new Error('Restore journal does not match its source snapshot');
  }
  return { file, operationRoot: resolve(operationRoot), journal, snapshot };
}


export function writeRestoreJournal(file: string, value: z.infer<typeof schema>, operationRoot: string) {
  assertJournalLocation(file, operationRoot);
  writePrivateJson(file, schema.parse(value));
}
