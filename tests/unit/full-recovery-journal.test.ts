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
  } as const;
  writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
  expect(readFullRecoveryJournal(file, root!).journal).toEqual(journal);
  writeFileSync(file, JSON.stringify({ ...journal, kind: 'restore' }), { mode: 0o600 });
  expect(() => readFullRecoveryJournal(file, root!)).toThrow();
});
