import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger, PermanentJobError } from '@storeweave/contracts';
import { createRuntime, Worker, type PlatformModule, type Runtime } from '@storeweave/kernel';
import { createTestDatabase } from './helpers';

const runtimes: Runtime[] = [];
// Deliberately short but still roomy enough that an actual PostgreSQL claim
// transaction is not mistaken for an unresponsive database operation.
const shortTiming = { staleLockSeconds: 4, heartbeatIntervalMs: 1_200, databaseTimeoutMs: 500, abortGraceMs: 1_000 };

afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(innerResolve => { resolve = innerResolve; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function createWorkerRuntime(name: string, jobs: PlatformModule['jobs']) {
  const url = await createTestDatabase();
  const runtime = await createRuntime({
    release: { id: name, version: '1.0.0', buildManifestChecksum: `sha256:${'4'.repeat(64)}` },
    roles: BASE_ROLES,
    config: baseConfigSchema.parse({ version: 1, store: { id: name, name }, database: { url }, logging: { level: 'error' } }),
    secrets: { get: () => undefined, has: () => false, listNames: () => [] }, logger: noopLogger, availableExtensions: {},
    modules: [{ name, version: '1.0.0', baseVersionRange: '^1.0.0', jobs }],
  });
  runtimes.push(runtime);
  await runtime.migrate();
  return runtime;
}

async function enqueue(runtime: Runtime, type: string) {
  return runtime.database.transaction(tx => runtime.jobs.enqueue(tx, { type, payload: {}, runAt: new Date(Date.now() - 1_000), maxAttempts: 3 }));
}

async function waitForAdvisoryWait(runtime: Runtime): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
    `);
    if (Number(result.rows[0]?.count) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Expected a transaction to wait on an advisory concurrency lock');
}

describe('worker execution boundaries', () => {
  it.each(['complete', 'retry', 'dead', 'replacement'] as const)(
    'waits for an in-flight heartbeat before terminal %s mutation', async outcome => {
      const type = `test.execution.terminal-${outcome}`;
      const handlerStarted = deferred();
      const handlerFinish = deferred();
      const heartbeatStarted = deferred();
      const heartbeatFinish = deferred<{ applied: boolean; status?: 'running' }>();
      const replacementKey = `terminal-replacement-${type}`;
      const runtime = await createWorkerRuntime(`worker-terminal-${outcome}`, [{
        type, jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() } },
        handler: async () => {
          handlerStarted.resolve();
          await handlerFinish.promise;
          if (outcome === 'retry') throw new Error('retry');
          if (outcome === 'dead') throw new PermanentJobError('dead');
        },
      }]);
      await runtime.database.transaction(tx => runtime.jobs.enqueue(tx, {
        type, payload: {}, runAt: new Date(Date.now() - 1_000),
        ...(outcome === 'replacement' ? { dedupeKey: replacementKey } : {}),
      }));
      const heartbeat = vi.spyOn(runtime.jobs, 'heartbeat').mockImplementation(async () => {
        heartbeatStarted.resolve();
        return heartbeatFinish.promise;
      });
      const terminal = vi.spyOn(runtime.jobs, outcome === 'complete' || outcome === 'replacement' ? 'complete' : 'fail');
      const worker = new Worker(runtime, {
        workerId: `terminal-${outcome}`, ...shortTiming,
      });
      const running = worker.runJobs();
      void running.catch(() => undefined);
      try {
        await within(handlerStarted.promise, 'terminal handler start');
        await within(heartbeatStarted.promise, 'in-flight heartbeat');
        if (outcome === 'replacement') {
          await runtime.database.transaction(tx => runtime.jobs.enqueue(tx, { type, payload: {}, dedupeKey: replacementKey, replaceExisting: true }));
        }
        handlerFinish.resolve();
        // This event-loop turn is a barrier: current code must not issue an ack
        // until the deliberately unresolved heartbeat has an outcome.
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(terminal).not.toHaveBeenCalled();
        heartbeatFinish.resolve({ applied: true, status: 'running' });
        const expected = outcome === 'complete' || outcome === 'replacement' ? { processed: 1, failed: 0 } : { processed: 0, failed: 1 };
        await expect(running).resolves.toEqual(expected);
        expect(heartbeat).toHaveBeenCalledTimes(1);
      } finally {
        handlerFinish.resolve();
        heartbeatFinish.resolve({ applied: true, status: 'running' });
        await running.catch(() => undefined);
      }
    },
  );

  it('fails closed on a real stale heartbeat rather than acknowledging afterwards', async () => {
    const type = 'test.execution.terminal-stale-heartbeat';
    const handlerStarted = deferred();
    const handlerFinish = deferred();
    const heartbeatStarted = deferred();
    const heartbeatFinish = deferred<{ applied: boolean; status?: 'running' }>();
    const runtime = await createWorkerRuntime('worker-terminal-stale-heartbeat', [{
      type, jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() } },
      handler: async () => { handlerStarted.resolve(); await handlerFinish.promise; },
    }]);
    await enqueue(runtime, type);
    vi.spyOn(runtime.jobs, 'heartbeat').mockImplementation(async () => {
      heartbeatStarted.resolve();
      return heartbeatFinish.promise;
    });
    const complete = vi.spyOn(runtime.jobs, 'complete');
    const worker = new Worker(runtime, {
      workerId: 'terminal-stale-heartbeat', ...shortTiming,
    });
    const running = worker.runJobs();
    void running.catch(() => undefined);
    try {
      await within(handlerStarted.promise, 'stale-heartbeat handler start');
      await within(heartbeatStarted.promise, 'stale heartbeat');
      handlerFinish.resolve();
      heartbeatFinish.resolve({ applied: false });
      await expect(running).rejects.toThrow('Lost fenced heartbeat');
      await expect(worker.waitForFatal()).resolves.toMatchObject({ name: 'WorkerFatalError' });
      expect(complete).not.toHaveBeenCalled();
    } finally {
      handlerFinish.resolve();
      heartbeatFinish.resolve({ applied: false });
      await running.catch(() => undefined);
    }
  });

  it('fenced heartbeats extend a live claim beyond its initial lease', async () => {
    const started = deferred();
    const finish = deferred();
    const type = 'test.execution.heartbeat';
    const runtime = await createWorkerRuntime('worker-heartbeat', [{
      type, jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() } },
      handler: async () => { started.resolve(); await finish.promise; },
    }]);
    await enqueue(runtime, type);
    const worker = new Worker(runtime, { workerId: 'heartbeat-worker', ...shortTiming });
    const running = worker.runJobs();
    await started.promise;
    await new Promise(resolve => setTimeout(resolve, 4_100));
    expect(await runtime.jobs.reclaimStale(runtime.database.db)).toBe(0);
    finish.resolve();
    await expect(running).resolves.toEqual({ processed: 1, failed: 0 });
  }, 15_000);

  it('aborts a timed-out handler and records the fenced retry rather than success', async () => {
    const type = 'test.execution.timeout';
    let observedAbort = false;
    const runtime = await createWorkerRuntime('worker-timeout', [{
      type,
      jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() }, execution: { timeoutMs: 100 } },
      handler: async (_payload, ctx) => new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => { observedAbort = true; reject(ctx.signal.reason); }, { once: true });
      }),
    }]);
    const job = await enqueue(runtime, type);
    const worker = new Worker(runtime, { workerId: 'timeout-worker', ...shortTiming });
    await expect(worker.runJobs()).resolves.toEqual({ processed: 0, failed: 1 });
    expect(observedAbort).toBe(true);
    const state = await runtime.database.db.execute<{ status: string; attempts: number; completed_at: Date | null }>(sql`
      SELECT status, attempts, completed_at FROM platform_jobs WHERE id = ${job.id}
    `);
    expect(state.rows).toEqual([{ status: 'pending', attempts: 1, completed_at: null }]);
  });

  it('enforces a shared key across two workers while a different key progresses', async () => {
    const sharedFirst = 'test.execution.shared-first';
    const sharedSecond = 'test.execution.shared-second';
    const independent = 'test.execution.independent';
    const sharedStarted = deferred();
    const sharedFinish = deferred();
    const independentDone = deferred();
    let activeShared = 0;
    let maximumShared = 0;
    const sharedContract = { currentVersion: 1, versions: { 1: z.object({}).strict() }, execution: { concurrencyKey: 'carrier:shared', concurrencyLimit: 1 } } as const;
    const runtime = await createWorkerRuntime('worker-concurrency', [
      { type: sharedFirst, jobContractV1: sharedContract, handler: async () => {
        activeShared += 1; maximumShared = Math.max(maximumShared, activeShared); sharedStarted.resolve();
        await sharedFinish.promise; activeShared -= 1;
      } },
      { type: sharedSecond, jobContractV1: sharedContract, handler: async () => {
        activeShared += 1; maximumShared = Math.max(maximumShared, activeShared); sharedStarted.resolve();
        await sharedFinish.promise; activeShared -= 1;
      } },
      { type: independent, jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() }, execution: { concurrencyLimit: 1 } }, handler: async () => { independentDone.resolve(); } },
    ]);
    await Promise.all([enqueue(runtime, sharedFirst), enqueue(runtime, sharedSecond), enqueue(runtime, independent)]);
    const first = new Worker(runtime, { workerId: 'concurrency-a', concurrency: 1, ...shortTiming });
    const second = new Worker(runtime, { workerId: 'concurrency-b', concurrency: 1, ...shortTiming });
    const runs = Promise.all([first.runJobs(), second.runJobs()]);
    void runs.catch(() => undefined);
    try {
      await within(sharedStarted.promise, 'a shared-key handler');
      await within(independentDone.promise, 'the independent-key handler');
      expect(maximumShared).toBe(1);
    } finally {
      // Do not leave a test process held by a handler gate if an assertion or
      // claim progress check fails: this is a diagnostic safety boundary, not
      // an assertion delay.
      sharedFinish.resolve();
    }
    const results = await within(runs, 'both workers after releasing shared work');
    expect(results.reduce((count, result) => count + result.processed, 0)).toBe(2);
    expect(maximumShared).toBe(1);
  });

  it('takes the policy lock before its claim snapshot, so a waiting worker cannot overclaim a committed running lease', async () => {
    const type = 'test.execution.snapshot';
    const key = 'snapshot-shared-key';
    const runtime = await createWorkerRuntime('worker-snapshot', [{
      type, jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() }, execution: { concurrencyKey: key, concurrencyLimit: 1 } },
      handler: async () => undefined,
    }]);
    await Promise.all([enqueue(runtime, type), enqueue(runtime, type)]);
    const policies = runtime.jobRegistry.claimConcurrencyPolicies();
    const claimed = deferred();
    const release = deferred();
    const first = runtime.database.transaction(async tx => {
      const rows = await runtime.jobs.claim(tx, 'snapshot-a', 1, undefined, 30, policies);
      expect(rows).toHaveLength(1);
      claimed.resolve();
      await release.promise;
    });
    await claimed.promise;
    const second = runtime.database.transaction(tx => runtime.jobs.claim(tx, 'snapshot-b', 1, undefined, 30, policies));
    await waitForAdvisoryWait(runtime);
    release.resolve();
    await first;
    await expect(second).resolves.toEqual([]);
  });

  it('takes every finite policy key before evaluating a multi-key claim', async () => {
    const firstType = 'test.execution.key-one';
    const secondType = 'test.execution.key-two';
    const secondKey = 'two-key-barrier';
    const runtime = await createWorkerRuntime('worker-all-keys', [
      { type: firstType, jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() }, execution: { concurrencyKey: 'one-key-barrier', concurrencyLimit: 1 } }, handler: async () => undefined },
      { type: secondType, jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() }, execution: { concurrencyKey: secondKey, concurrencyLimit: 1 } }, handler: async () => undefined },
    ]);
    await Promise.all([enqueue(runtime, firstType), enqueue(runtime, secondType)]);
    const locked = deferred();
    const release = deferred();
    const holder = runtime.database.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${secondKey}, 0))`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const claimant = runtime.database.transaction(tx => runtime.jobs.claim(tx, 'all-keys-worker', 2, undefined, 30, runtime.jobRegistry.claimConcurrencyPolicies()));
    await waitForAdvisoryWait(runtime);
    release.resolve();
    await holder;
    await expect(claimant).resolves.toHaveLength(2);
  });
});
