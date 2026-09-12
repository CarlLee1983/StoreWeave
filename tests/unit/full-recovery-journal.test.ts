import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { readFullRecoveryJournal } from '../../tools/cli/src/full-recovery-journal';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('binds full recovery progress to its bundle catalogue and rejects paired-journal-shaped forgeries', () => {
  root = mkdtempSync(join(tmpdir(), 'storeweave-full-recovery-'));
  chmodSync(root, 0o700);
  const id = randomUUID(), home = join(root, id), file = join(home, 'journal.json');
  mkdirSync(home, { mode: 0o700 });
  const journal = {
    schemaVersion: 1, kind: 'full-recovery', id, phase: 'media-restored',
    bundle: { directory: '/private/bundle', manifestChecksum: `sha256:${'a'.repeat(64)}`, storageChecksum: 'b'.repeat(64), objectCount: 3 },
    target: { systemIdentifier: '100', live: { name: 'store', oid: '200' } },
    scratch: { name: `storeweave_full_recovery_${id.replaceAll('-', '')}`, oid: '300' },
    quarantineName: `storeweave_retained_${id.replaceAll('-', '')}`,
    restored: { file: 'restored-keys.json', byteSize: 42, sha256: 'c'.repeat(64), count: 3 },
  } as const;
  writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
  expect(readFullRecoveryJournal(file, root!).journal).toEqual(journal);
  writeFileSync(file, JSON.stringify({ ...journal, kind: 'restore' }), { mode: 0o600 });
  expect(() => readFullRecoveryJournal(file, root!)).toThrow();
  // A recovery cannot have published objects before its database was restored;
  // a journal claiming otherwise would authorise deleting keys it never wrote.
  writeFileSync(file, JSON.stringify({ ...journal, phase: 'planned', scratch: { ...journal.scratch, oid: null } }), { mode: 0o600 });
  expect(() => readFullRecoveryJournal(file, root!)).toThrow();
  // A failed recovery keeps its key list: that list is what makes it reclaimable.
  writeFileSync(file, JSON.stringify({ ...journal, phase: 'failed' }), { mode: 0o600 });
  expect(readFullRecoveryJournal(file, root!).journal.phase).toBe('failed');
});
