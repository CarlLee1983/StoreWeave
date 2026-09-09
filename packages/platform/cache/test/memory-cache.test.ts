import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheManager } from '../src';

describe('MemoryCacheManager', () => {
  it('is a namespace-isolated TTL test double and never permits permanent entries', async () => {
    vi.useFakeTimers();
    try {
      const manager = new MemoryCacheManager();
      const first = manager.forNamespace('catalog');
      const second = manager.forNamespace('identity');
      await first.set('shared-key', { id: 1 }, { ttlMs: 100 });
      await second.set('shared-key', { id: 2 }, { ttlMs: 100 });
      await first.clear();
      await expect(first.get('shared-key')).resolves.toBeUndefined();
      await expect(second.get('shared-key')).resolves.toEqual({ id: 2 });
      const mutable = { nested: { id: 3 } };
      await second.set('serialized', mutable, { ttlMs: 100 });
      mutable.nested.id = 4;
      await expect(second.get('serialized')).resolves.toEqual({ nested: { id: 3 } });
      const bytes = Buffer.from([1, 2, 3]);
      await second.set('bytes', bytes, { ttlMs: 100 });
      await expect(second.get('bytes')).resolves.toEqual(bytes);
      await expect(second.set('no-ttl', true, { ttlMs: 0 })).rejects.toThrow(/ttlMs/);
      await expect(second.set('undefined', undefined, { ttlMs: 100 })).rejects.toThrow(/undefined/);
      vi.advanceTimersByTime(101);
      await expect(second.get('shared-key')).resolves.toBeUndefined();
      await manager.close();
      expect(() => manager.forNamespace('catalog')).toThrow(/closed/);
    } finally { vi.useRealTimers(); }
  });
});
