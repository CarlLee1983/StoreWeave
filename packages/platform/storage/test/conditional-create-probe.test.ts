import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { StorageManager, type ObjectStore, type StoredContent } from '../src';

/**
 * A full restore's "a divergent object is never overwritten" guarantee rests on
 * the object store honouring a conditional create. Some S3-compatible servers
 * ignore an unknown condition and report a plain overwrite as a create, so the
 * restore probes the store before it writes anything.
 */
class ProbeStore implements ObjectStore {
  readonly keys = new Map<string, Buffer>();
  constructor(private readonly honoursCondition: boolean) {}
  async put(key: string, stream: Readable) { return this.write(key, stream); }
  async putIfAbsent(key: string, _byteSize: number, stream: Readable) {
    if (this.keys.has(key) && this.honoursCondition) { stream.destroy(); return { created: false }; }
    return { created: true, ...await this.write(key, stream) };
  }
  async open(key: string): Promise<StoredContent> {
    const bytes = this.keys.get(key);
    if (!bytes) throw Object.assign(new Error('NoSuchKey'), { code: 'ENOENT' });
    return { stream: Readable.from([bytes]), byteSize: bytes.byteLength };
  }
  async remove(key: string) { this.keys.delete(key); }
  async cleanupTemporary() {}
  async healthCheck() {}
  private async write(key: string, stream: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    this.keys.set(key, bytes);
    const { createHash } = await import('node:crypto');
    return { byteSize: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}

const pool = {} as Pool;

describe('conditional create probe', () => {
  it('passes on a store that refuses a second create and leaves no probe key behind', async () => {
    const store = new ProbeStore(true);
    const manager = new StorageManager(pool, store);
    await expect(manager.assertConditionalCreateSupport('platform-storage')).resolves.toBeUndefined();
    expect(store.keys.size).toBe(0);
  });

  it('fails closed on a store that silently overwrites, and still cleans up its probe key', async () => {
    const store = new ProbeStore(false);
    const manager = new StorageManager(pool, store);
    await expect(manager.assertConditionalCreateSupport('platform-storage'))
      .rejects.toThrow(/ignores conditional creates/);
    expect(store.keys.size).toBe(0);
  });
});
