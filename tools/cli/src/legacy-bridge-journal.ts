import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { assertJournalLocation, readPrivateJson, writePrivateJson } from './read-release-snapshot';
import { readLegacySafetySnapshot } from './legacy-safety-snapshot';
import { readLegacyPairedSnapshot } from './legacy-paired-snapshot';

const reference = z.object({ directory: z.string().refine(isAbsolute), checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
const phases = ['safety', 'paired', 'migrating', 'migrated', 'activated'] as const;
const schema = z.object({ schemaVersion: z.literal(1), kind: z.literal('legacy-b01-bridge'), id: z.string().uuid(),
  catalogId: z.literal('legacy-commerce-0.1.0-pre-b02'), evidence: z.string().trim().min(1).max(4096),
  phase: z.enum(phases), safety: reference, snapshot: reference.nullable(),
}).strict().refine(value => (value.phase === 'safety') === (value.snapshot === null), 'Paired bridge phase requires its snapshot');

/** Create immediately after raw capture and before baseline DDL, while holding the operation lock. */
export async function createLegacyBridgeJournal(root: string, safetyDirectory: string, safetyChecksum: string, evidence: string) {
  root = resolve(root);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('Bridge journal root must be owned and 0700');
  const safety = await readLegacySafetySnapshot(safetyDirectory, safetyChecksum);
  const id = randomUUID(), home = join(root, id), file = join(home, 'bridge.json');
  const journal = schema.parse({ schemaVersion: 1, kind: 'legacy-b01-bridge', id, phase: 'safety',
    catalogId: 'legacy-commerce-0.1.0-pre-b02', evidence,
    safety: { directory: safety.directory, checksum: safetyChecksum }, snapshot: null });
  mkdirSync(home, { mode: 0o700 });
  assertJournalLocation(file, root);
  writePrivateJson(file, journal);
  return file;
}

export async function readLegacyBridgeJournal(file: string, operationRoot: string) {
  file = resolve(file);
  assertJournalLocation(file, operationRoot);
  const journal = schema.parse(readPrivateJson(file));
  if (basename(file) !== 'bridge.json' || basename(dirname(file)) !== journal.id) throw new Error('Bridge journal identity mismatch');
  const safety = await readLegacySafetySnapshot(journal.safety.directory, journal.safety.checksum);
  const snapshot = journal.snapshot ? await readLegacyPairedSnapshot(journal.snapshot.directory, journal.snapshot.checksum) : null;
  if (snapshot && (snapshot.manifest.safety.directory !== safety.directory
    || snapshot.manifest.safety.checksum !== journal.safety.checksum
    || snapshot.manifest.baseline.catalogId !== journal.catalogId || snapshot.manifest.baseline.evidence !== journal.evidence)) throw new Error('Bridge journal snapshots do not belong to the same transition');
  return { file, operationRoot: resolve(operationRoot), journal, safety, snapshot };
}

/** Candidate authority remains the original safety reference; attaching a pair can never replace it. */
export async function advanceLegacyBridgeJournal(file: string, operationRoot: string, phase: typeof phases[number],
  pair?: z.infer<typeof reference>) {
  const recorded = await readLegacyBridgeJournal(file, operationRoot);
  const before = phases.indexOf(recorded.journal.phase), after = phases.indexOf(phase);
  if (after < before || after > before + 1 || (pair && recorded.journal.phase !== 'safety')) throw new Error('Invalid bridge journal phase transition');
  let snapshot = recorded.journal.snapshot;
  if (pair) {
    const checked = await readLegacyPairedSnapshot(pair.directory, pair.checksum);
    if (checked.manifest.safety.directory !== recorded.safety.directory
      || checked.manifest.safety.checksum !== recorded.journal.safety.checksum
      || checked.manifest.baseline.evidence !== recorded.journal.evidence) throw new Error('Bridge pair differs from its original safety snapshot');
    snapshot = { directory: checked.directory, checksum: pair.checksum };
  }
  const journal = schema.parse({ ...recorded.journal, phase, snapshot });
  assertJournalLocation(recorded.file, recorded.operationRoot);
  writePrivateJson(recorded.file, journal);
  return readLegacyBridgeJournal(recorded.file, recorded.operationRoot);
}
