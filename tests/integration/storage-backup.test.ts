import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { assertStorageBackupMatchesDatabase, captureStorageBackup, readStorageBackup, readStorageBackupCatalog, restoreStorageBackup, writeStorageBackupCatalog } from '../../tools/cli/src/storage-backup';
import { createHarness, type TestHarness } from './helpers';

let storageRoot: string;
let backupRoot: string;
let harness: TestHarness;

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'storeweave-storage-backup-data-'));
  backupRoot = await mkdtemp(join(tmpdir(), 'storeweave-storage-backup-bundle-'));
  harness = await createHarness({ storageRoot });
});

afterEach(async () => {
  await harness?.close();
  await rm(storageRoot, { recursive: true, force: true });
  await rm(backupRoot, { recursive: true, force: true });
});

it('captures ready objects under the database snapshot and restores a missing byte object by its immutable key', async () => {
  const scope = harness.runtime.storage.forNamespace('platform-storage');
  const payload = Buffer.from('the object the DB refers to');
  const saved = await scope.upload({ stream: Readable.from([payload]), originalName: 'proof.txt', contentType: 'text/plain', visibility: 'private' });

  const backup = await harness.runtime.withReleaseSnapshot((_, client) => captureStorageBackup(harness.runtime, client, backupRoot));
  expect(backup.objects).toEqual([expect.objectContaining({
    id: saved.id, namespace: 'platform-storage', storageKey: saved.storageKey,
    byteSize: payload.byteLength, sha256: createHash('sha256').update(payload).digest('hex'),
  })]);

  const storedFile = join(storageRoot, 'objects', saved.storageKey);
  await rm(storedFile);
  await expect(scope.open(saved.id)).rejects.toMatchObject({ code: 'ENOENT' });

  const checked = await readStorageBackup(backupRoot, backup);
  await assertStorageBackupMatchesDatabase(harness.runtime, checked);
  await restoreStorageBackup(harness.runtime, backupRoot, checked);
  const reopened = await scope.open(saved.id);
  const restored = await readFile(storedFile);
  expect(restored).toEqual(payload);
  expect(reopened.object).toMatchObject({ id: saved.id, sha256: backup.objects[0]!.sha256 });
});

it('rejects a byte mismatch before writing an existing object', async () => {
  const scope = harness.runtime.storage.forNamespace('platform-storage');
  const payload = Buffer.from('authoritative bytes');
  const saved = await scope.upload({ stream: Readable.from([payload]), originalName: 'proof.txt', contentType: 'text/plain', visibility: 'private' });
  const backup = await harness.runtime.withReleaseSnapshot((_, client) => captureStorageBackup(harness.runtime, client, backupRoot));
  const storedFile = join(storageRoot, 'objects', saved.storageKey);
  await writeFile(storedFile, 'corrupted object');

  await expect(restoreStorageBackup(harness.runtime, backupRoot, backup)).rejects.toThrow('conflicts');
  expect(await readFile(storedFile, 'utf8')).toBe('corrupted object');
});

it('refuses to restore bytes into a database whose ready-object set differs from the bundle', async () => {
  const scope = harness.runtime.storage.forNamespace('platform-storage');
  await scope.upload({ stream: Readable.from(['captured']), originalName: 'captured.txt', contentType: 'text/plain', visibility: 'private' });
  const backup = await harness.runtime.withReleaseSnapshot((_, client) => captureStorageBackup(harness.runtime, client, backupRoot));
  await scope.upload({ stream: Readable.from(['not in the snapshot']), originalName: 'later.txt', contentType: 'text/plain', visibility: 'private' });

  await expect(assertStorageBackupMatchesDatabase(harness.runtime, backup)).rejects.toThrow('do not match');
});

it('rejects a tampered or symlinked backup before restore', async () => {
  const scope = harness.runtime.storage.forNamespace('platform-storage');
  const saved = await scope.upload({ stream: Readable.from(['safe']), originalName: 'proof.txt', contentType: 'text/plain', visibility: 'private' });
  const backup = await harness.runtime.withReleaseSnapshot((_, client) => captureStorageBackup(harness.runtime, client, backupRoot));
  const file = join(backupRoot, backup.objects[0]!.file);
  await writeFile(file, 'tampered');
  await expect(readStorageBackup(backupRoot, backup)).rejects.toThrow('checksum mismatch');

  // Restore the valid capture, then replace the archived object with a symlink.
  await mkdir(join(backupRoot, 'outside'));
  await writeFile(join(backupRoot, 'outside', 'object'), 'safe');
  await rm(file);
  await import('node:fs/promises').then(({ symlink }) => symlink(join(backupRoot, 'outside', 'object'), file));
  await expect(readStorageBackup(backupRoot, backup)).rejects.toThrow('private regular file');
  expect(saved.id).toBeTruthy();
});

it('keeps the outer manifest small by checksumming a bounded storage catalogue separately', async () => {
  const scope = harness.runtime.storage.forNamespace('platform-storage');
  await scope.upload({ stream: Readable.from(['catalogue']), originalName: 'catalogue.txt', contentType: 'text/plain', visibility: 'private' });
  const backup = await harness.runtime.withReleaseSnapshot((_, client) => captureStorageBackup(harness.runtime, client, backupRoot));
  const catalogue = await writeStorageBackupCatalog(backupRoot, backup);
  await expect(readStorageBackupCatalog(backupRoot, catalogue)).resolves.toEqual(backup);

  await writeFile(join(backupRoot, 'storage.json'), '{"schemaVersion":1,"objects":[]}');
  await expect(readStorageBackupCatalog(backupRoot, catalogue)).rejects.toThrow('catalogue checksum mismatch');
});
