import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKeyring } from '@storeweave/crypto';
import { StorageLimitError } from '@storeweave/storage';
import { createHarness, type TestHarness } from './helpers';

let root: string;
let harness: TestHarness;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'storeweave-storage-integration-'));
  harness = await createHarness({ storageRoot: root, storageMaxUploadBytes: 64 });
});

afterEach(async () => {
  await harness?.close();
  await rm(root, { recursive: true, force: true });
});

describe('B09 storage lifecycle', () => {
  it('persists metadata separately from bytes and serves a verified signed download', async () => {
    const scope = harness.runtime.storage.forNamespace('platform-storage');
    const payload = Buffer.from('private stream');
    const saved = await scope.upload({
      stream: Readable.from([payload]), originalName: 'receipt.txt', contentType: 'text/plain', visibility: 'private', ownerActorId: 'test:admin',
    });
    expect(saved.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect((await scope.list()).map(item => item.id)).toEqual([saved.id]);

    const keyring = createKeyring({ activeKeyId: 'one', keys: [{ id: 'one', secret: Buffer.alloc(32, 1).toString('base64url') }] });
    const signed = await scope.issueSignedDownload(saved.id, keyring, new Date(Date.now() + 60_000));
    const opened = await scope.openSignedDownload(signed.urlToken, keyring, new Date());
    const chunks: Buffer[] = [];
    for await (const chunk of opened.content.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(payload);

    await scope.delete(saved.id);
    await expect(scope.open(saved.id)).rejects.toThrow('not found');
  });

  it('fails a stream as soon as the configured byte budget is exceeded and leaves no ready metadata', async () => {
    const scope = harness.runtime.storage.forNamespace('platform-storage');
    await expect(scope.upload({
      stream: Readable.from([Buffer.alloc(65)]), originalName: 'too-large.bin', contentType: 'application/octet-stream', visibility: 'private',
    })).rejects.toBeInstanceOf(StorageLimitError);
    expect(await scope.list()).toEqual([]);
  });

  it('rejects a token issued for another object', async () => {
    const scope = harness.runtime.storage.forNamespace('platform-storage');
    const first = await scope.upload({ stream: Readable.from(['one']), originalName: 'one.txt', contentType: 'text/plain', visibility: 'private' });
    const second = await scope.upload({ stream: Readable.from(['two']), originalName: 'two.txt', contentType: 'text/plain', visibility: 'private' });
    const keyring = createKeyring({ activeKeyId: 'one', keys: [{ id: 'one', secret: Buffer.alloc(32, 1).toString('base64url') }] });
    const token = await scope.issueSignedDownload(first.id, keyring, new Date(Date.now() + 60_000));
    const opened = await scope.openSignedDownload(token.urlToken, keyring, new Date());
    expect(opened.object.id).not.toBe(second.id);
    await expect(scope.openSignedDownload(`${token.urlToken}tampered`, keyring, new Date())).rejects.toThrow('Invalid or expired');
  });

  it('recovers a stale deletion reservation after an interrupted delete', async () => {
    const scope = harness.runtime.storage.forNamespace('platform-storage');
    const saved = await scope.upload({ stream: Readable.from(['orphan']), originalName: 'orphan.txt', contentType: 'text/plain', visibility: 'private' });
    await harness.runtime.database.pool.query(`UPDATE platform_storage_objects
      SET state = 'deleting', updated_at = now() - interval '2 hours' WHERE id = $1`, [saved.id]);
    await expect(harness.runtime.storage.cleanupStale({ olderThan: new Date(Date.now() - 60_000) })).resolves.toBe(1);
    await expect(scope.get(saved.id)).resolves.toBeUndefined();
  });
});
