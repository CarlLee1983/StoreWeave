import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlatformError } from '@storeweave/contracts';
import { createHarness, runJobsUntilProcessed } from './helpers';

// 1×1 transparent PNG. It exercises Sharp's real decoder without a fixture file.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

async function mediaHarness() {
  const storageRoot = mkdtempSync(join(tmpdir(), 'storeweave-media-'));
  const harness = await createHarness({ storageRoot });
  return { harness, close: async () => { await harness.close(); rmSync(storageRoot, { recursive: true, force: true }); } };
}

describe('B10 media lifecycle', () => {
  it('processes a private original into one preview and protects referenced media', async () => {
    const { harness: h, close } = await mediaHarness();
    try {
      const asset = await h.runtime.media.upload({ stream: Readable.from(PNG), originalName: 'sample.png', contentType: 'image/png', ownerActorId: 'test:admin' });
      expect(asset.status).toBe('pending');
      // A process can die after claiming the media job. The queued job must be
      // able to reclaim that generation without creating a second derivative.
      await h.runtime.database.pool.query(
        'UPDATE platform_media_assets SET status = $2, processing_token = $3 WHERE id = $1',
        [asset.id, 'processing', randomUUID()],
      );
      expect(await runJobsUntilProcessed(h.worker)).toMatchObject({ processed: 1, failed: 0 });
      // The persisted job is safe after a worker restart: `process` makes an
      // already-ready generation a no-op rather than creating another derivative.
      await h.runtime.media.process({ assetId: asset.id, generation: asset.generation }, { signal: new AbortController().signal });
      const ready = await h.runtime.media.get(asset.id);
      expect(ready).toMatchObject({ status: 'ready', width: 1, height: 1 });
      await expect(h.runtime.media.openPreview(asset.id)).resolves.toMatchObject({ object: { contentType: 'image/webp' } });

      await h.runtime.database.transaction(tx => h.runtime.media.references.replace(tx, { ownerType: 'test.article', ownerId: randomUUID(), mediaIds: [asset.id] }));
      await expect(h.runtime.media.remove(asset.id)).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<PlatformError>);
    } finally { await close(); }
  });

  it('records invalid source bytes as failed and allows a generation-fenced retry', async () => {
    const { harness: h, close } = await mediaHarness();
    try {
      const asset = await h.runtime.media.upload({ stream: Readable.from('not an image'), originalName: 'bad.png', contentType: 'image/png', ownerActorId: 'test:admin' });
      await expect(h.runtime.media.process({ assetId: asset.id, generation: asset.generation }, { signal: new AbortController().signal })).rejects.toThrow();
      const failed = await h.runtime.media.get(asset.id);
      expect(failed).toMatchObject({ status: 'failed', generation: 1 });
      const retried = await h.runtime.media.retry(asset.id);
      expect(retried).toMatchObject({ status: 'pending', generation: 2, processingError: null });
    } finally { await close(); }
  });

  it('reconciles an interrupted deleting intent and removes an aged unowned media object', async () => {
    const { harness: h, close } = await mediaHarness();
    try {
      const asset = await h.runtime.media.upload({
        stream: Readable.from(PNG), originalName: 'interrupted.png', contentType: 'image/png', ownerActorId: 'test:admin',
      });
      await h.runtime.database.pool.query(
        "UPDATE platform_media_assets SET status = 'deleting' WHERE id = $1",
        [asset.id],
      );
      const orphan = await h.runtime.storage.upload('platform-media', {
        stream: Readable.from(PNG), originalName: 'orphan.png', contentType: 'image/png',
        visibility: 'private', ownerActorId: 'test:admin',
      });
      await h.runtime.database.pool.query(
        "UPDATE platform_storage_objects SET created_at = $2 WHERE id = $1",
        [orphan.id, new Date('2020-01-01T00:00:00.000Z')],
      );

      await expect(h.runtime.media.cleanup({ olderThan: new Date('2021-01-01T00:00:00.000Z') }))
        .resolves.toEqual({ deleted: 2 });
      await expect(h.runtime.media.get(asset.id)).resolves.toBeUndefined();
      await expect(h.runtime.storage.get('platform-media', asset.originalObjectId)).resolves.toBeUndefined();
      await expect(h.runtime.storage.get('platform-media', orphan.id)).resolves.toBeUndefined();
    } finally { await close(); }
  });
});
