import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JobPayloadDecodeError, JobRegistry } from '../src/job-registry';

const v1 = z.object({ value: z.string() }).strict();
const v2 = z.object({ message: z.string() }).strict();

function registryWithVersionedJob() {
  const registry = new JobRegistry();
  registry.register('test.versioned', async () => undefined, 'test-owner', {
    currentVersion: 2,
    versions: { 1: v1, 2: v2 },
    upgrades: { 1: payload => ({ message: (payload as { value: string }).value }) },
  });
  return registry;
}

describe('JobRegistry payload contracts', () => {
  it('normalizes current-version metadata and upgrades validated v1 data to the handler shape', () => {
    const registry = registryWithVersionedJob();
    expect(registry.currentVersion('test.versioned')).toBe(2);
    expect(registry.decode('test.versioned', { value: 'legacy' }, 1)).toEqual({ message: 'legacy' });
  });

  it('rejects an invalid source payload and unknown persisted version before a handler can run', () => {
    const registry = registryWithVersionedJob();
    expect(() => registry.decode('test.versioned', { value: 1 }, 1)).toThrow(JobPayloadDecodeError);
    expect(() => registry.decode('test.versioned', { message: 'future' }, 3)).toThrow('unknown payload version 3');
  });

  it('reports a missing step upgrader as a decode failure for durable quarantine', () => {
    const registry = new JobRegistry();
    registry.register('test.missing-upgrade', async () => undefined, 'test-owner', {
      currentVersion: 2, versions: { 1: v1, 2: v2 },
    });
    expect(() => registry.decode('test.missing-upgrade', { value: 'orphan' }, 1))
      .toThrow('missing payload upgrader 1 -> 2');
  });

  it('blocks fenced-dispatch cutover with locateable legacy owner and job type', () => {
    const registry = registryWithVersionedJob();
    registry.register('ext.legacy.send', async () => undefined, 'legacy-extension');
    expect(() => registry.assertPayloadDispatchReady()).toThrow('legacy-extension:ext.legacy.send');
  });

  it('normalizes default execution metadata and rejects conflicting shared queue limits before a worker claims', () => {
    const registry = new JobRegistry();
    registry.register('test.first', async () => undefined, 'first', {
      currentVersion: 1, versions: { 1: v1 }, execution: { concurrencyKey: 'shared-carrier', concurrencyLimit: 1 },
    });
    expect(registry.executionFor('test.first')).toEqual({ timeoutMs: 300_000, concurrencyKey: 'shared-carrier', concurrencyLimit: 1 });
    expect(() => registry.register('test.second', async () => undefined, 'second', {
      currentVersion: 1, versions: { 1: v1 }, execution: { concurrencyKey: 'shared-carrier', concurrencyLimit: 2 },
    })).toThrow('conflicting limits 1 and 2');
  });
});
