import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { assertJournalLocation, readPrivateJson, writePrivateJson } from './read-release-snapshot';

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rawChecksum = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[1-9]\d*$/);
const databaseName = z.string().min(1).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 63);
const storageKey = z.string().regex(/^[a-z0-9][a-z0-9/_-]{0,255}$/);

/**
 * A restore replays media into the live object store before the database
 * cutover, so a failure after that point leaves bytes the live database does
 * not reference. The keys this recovery published are recorded so `discard`
 * can remove exactly those and nothing else. They live in their own private
 * file beside the journal: a bundle may hold a million objects, and the
 * journal itself stays small enough to read under the default limit.
 */
const restoredKeysCatalogSchema = z.object({
  file: z.literal('restored-keys.json'),
  byteSize: z.number().int().positive().max(128 * 1024 * 1024),
  sha256: rawChecksum,
  count: z.number().int().min(0).max(1_000_000),
}).strict();
const restoredKeysSchema = z.object({ schemaVersion: z.literal(1), keys: z.array(storageKey) }).strict();
export type RestoredKeysCatalog = z.infer<typeof restoredKeysCatalogSchema>;

export const fullRecoveryJournalSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('full-recovery'), id: z.string().uuid(),
  phase: z.enum(['planned', 'scratch-created', 'database-restored', 'media-restored', 'cutover-intent', 'cutover-committed', 'verified', 'failed']),
  bundle: z.object({ directory: z.string().refine(isAbsolute), manifestChecksum: checksum, storageChecksum: rawChecksum, objectCount: z.number().int().min(0) }).strict(),
  target: z.object({ systemIdentifier: oid, live: z.object({ name: databaseName, oid: oid.nullable() }).strict() }).strict(),
  scratch: z.object({ name: databaseName, oid: oid.nullable() }).strict(),
  quarantineName: databaseName.nullable(),
  restored: restoredKeysCatalogSchema.nullable(),
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
    || (journal.target.live.oid !== null && journal.quarantineName === null)
    || (journal.restored !== null && ['planned', 'scratch-created'].includes(journal.phase))) throw new Error('Full recovery journal identity mismatch');
  return { file, operationRoot: resolve(operationRoot), journal };
}

export function writeFullRecoveryJournal(file: string, value: FullRecoveryJournal, operationRoot: string) {
  assertJournalLocation(file, operationRoot);
  writePrivateJson(file, fullRecoveryJournalSchema.parse(value));
}

/** Records the keys this recovery published, so a failed run can take back exactly its own bytes. */
export function writeRestoredKeys(journalFile: string, keys: readonly string[], operationRoot: string): RestoredKeysCatalog {
  const file = join(dirname(resolve(journalFile)), 'restored-keys.json');
  assertJournalLocation(file, operationRoot);
  const value = restoredKeysSchema.parse({ schemaVersion: 1, keys: [...keys] });
  writePrivateJson(file, value);
  const serialized = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  return restoredKeysCatalogSchema.parse({
    file: 'restored-keys.json', byteSize: serialized.byteLength,
    sha256: createHash('sha256').update(serialized).digest('hex'), count: value.keys.length,
  });
}

export function readRestoredKeys(journalFile: string, catalog: RestoredKeysCatalog, operationRoot: string): readonly string[] {
  const file = join(dirname(resolve(journalFile)), catalog.file);
  assertJournalLocation(file, operationRoot);
  const raw = readPrivateJson(file, 128 * 1024 * 1024);
  const serialized = Buffer.from(`${JSON.stringify(raw)}\n`, 'utf8');
  if (serialized.byteLength !== catalog.byteSize || createHash('sha256').update(serialized).digest('hex') !== catalog.sha256) {
    throw new Error('Restored storage key list does not match its journal checksum');
  }
  const value = restoredKeysSchema.parse(raw);
  if (value.keys.length !== catalog.count) throw new Error('Restored storage key list count mismatch');
  return value.keys;
}
