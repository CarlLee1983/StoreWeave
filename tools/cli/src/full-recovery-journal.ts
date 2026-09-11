import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { assertJournalLocation, readPrivateJson, writePrivateJson } from './read-release-snapshot';

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rawChecksum = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[1-9]\d*$/);
const databaseName = z.string().min(1).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 63);

export const fullRecoveryJournalSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('full-recovery'), id: z.string().uuid(),
  phase: z.enum(['planned', 'scratch-created', 'database-restored', 'media-restored', 'cutover-intent', 'cutover-committed', 'verified', 'failed']),
  bundle: z.object({ directory: z.string().refine(isAbsolute), manifestChecksum: checksum, storageChecksum: rawChecksum, objectCount: z.number().int().min(0) }).strict(),
  target: z.object({ systemIdentifier: oid, live: z.object({ name: databaseName, oid: oid.nullable() }).strict() }).strict(),
  scratch: z.object({ name: databaseName, oid: oid.nullable() }).strict(),
  quarantineName: databaseName.nullable(),
}).strict();
export type FullRecoveryJournal = z.infer<typeof fullRecoveryJournalSchema>;

/** Full recovery has its own state machine; B02's paired rollback journal must never resume it. */
export function readFullRecoveryJournal(file: string, operationRoot: string) {
  file = resolve(file);
  assertJournalLocation(file, operationRoot);
  const journal = fullRecoveryJournalSchema.parse(readPrivateJson(file));
  const suffix = journal.id.replaceAll('-', '');
  if (basename(file) !== 'journal.json' || basename(dirname(file)) !== journal.id
    || journal.scratch.name !== `storeweave_full_recovery_${suffix}`
    || (journal.quarantineName !== null && journal.quarantineName !== `storeweave_retained_${suffix}`)
    || (journal.phase === 'planned' && journal.scratch.oid !== null)
    || (!['planned', 'failed'].includes(journal.phase) && journal.scratch.oid === null)
    || (journal.target.live.oid === null && journal.quarantineName !== null)
    || (journal.target.live.oid !== null && journal.quarantineName === null)) throw new Error('Full recovery journal identity mismatch');
  return { file, operationRoot: resolve(operationRoot), journal };
}

export function writeFullRecoveryJournal(file: string, value: FullRecoveryJournal, operationRoot: string) {
  assertJournalLocation(file, operationRoot);
  writePrivateJson(file, fullRecoveryJournalSchema.parse(value));
}
