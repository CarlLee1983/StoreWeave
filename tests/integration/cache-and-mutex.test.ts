import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { Database, runMigrations } from '@storeweave/db';
import { cacheMigrations, PostgresCacheManager, PostgresMutexManager } from '@storeweave/cache';
import { COMMERCE_ROLES } from '@storeweave/authorization';
import { commerceConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { createRuntime, type ModuleCacheScopes, type Runtime } from '@storeweave/kernel';
import { testSecretProvider } from './helpers';
import { createTestDatabase } from './helpers';

const databases: Database[] = [];
const mutexes: PostgresMutexManager[] = [];
const runtimes: Runtime[] = [];
const children: ChildProcess[] = [];
const MUTEX_PROCESS_FIXTURE = `
  const { createHash } = require('node:crypto');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.CACHE_MUTEX_PROCESS_DATABASE_URL });
  const digest = createHash('sha256').update('storeweave/cache-mutex/v1/inventory/cross-process', 'utf8').digest();
  const first = digest.readInt32BE(0); const second = digest.readInt32BE(4);
  (async () => {
    const locked = await pool.query('SELECT pg_catalog.pg_try_advisory_lock($1::integer, $2::integer) AS acquired', [first, second]);
    if (!locked.rows[0]?.acquired) throw new Error('child could not acquire advisory lock');
    process.stdout.write('ready\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    await pool.query('SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer)', [first, second]);
    await pool.end();
  })().catch(async error => { process.stderr.write(String(error.stack || error)); await pool.end(); process.exitCode = 1; });
`;
const CACHE_INVALIDATION_PROCESS = `
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.CACHE_INVALIDATION_PROCESS_DATABASE_URL });
  (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await pool.query('DELETE FROM public.platform_cache WHERE namespace = $1 AND key = $2', ['catalog', 'cross-process-cache']);
      if (result.rowCount === 1) { await pool.end(); return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Cache value was never visible to child process');
  })().catch(async error => { process.stderr.write(String(error.stack || error)); await pool.end(); process.exitCode = 1; });
`;

afterEach(async () => {
  await Promise.all(mutexes.splice(0).map(mutex => mutex.close()));
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(databases.splice(0).map(database => database.close()));
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      });
    }
  }));
});

async function setup() {
  const url = await createTestDatabase();
  const first = new Database({ url, poolSize: 4 });
  const second = new Database({ url, poolSize: 4 });
  databases.push(first, second);
  await runMigrations(first.pool, [cacheMigrations]);
  const firstCache = new PostgresCacheManager(first.pool, { cleanupBatchSize: 1 });
  const secondCache = new PostgresCacheManager(second.pool, { cleanupBatchSize: 1 });
  const firstMutex = new PostgresMutexManager({ url, poolSize: 2, retryIntervalMs: 5 });
  const secondMutex = new PostgresMutexManager({ url, poolSize: 2, retryIntervalMs: 5 });
  mutexes.push(firstMutex, secondMutex);
  return { url, first, second, firstCache, secondCache, firstMutex, secondMutex };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function pause(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function mutexPool(mutex: PostgresMutexManager): Pool { return (mutex as unknown as { pool: Pool }).pool; }

async function startMutexChild(url: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', MUTEX_PROCESS_FIXTURE], {
    env: { ...process.env, CACHE_MUTEX_PROCESS_DATABASE_URL: url }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const stdout = child.stdout;
    if (!stdout) {
      reject(new Error('Mutex child did not expose stdout'));
      return;
    }
    const onData = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready\n')) {
        stdout.off('data', onData);
        resolve();
      }
    };
    stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`Mutex child exited before ready: ${code}/${signal}`)));
  });
  return child;
}

function startInvalidationChild(url: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', CACHE_INVALIDATION_PROCESS], {
    env: { ...process.env, CACHE_INVALIDATION_PROCESS_DATABASE_URL: url }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  return child;
}

describe('PostgreSQL cache', () => {
  it('injects only module-bound cache and mutex scopes through runtime composition', async () => {
    const url = await createTestDatabase();
    const bindings = new Map<string, ModuleCacheScopes>();
    const runtime = await createRuntime({
      roles: COMMERCE_ROLES,
      release: { id: 'cache-binding', version: '1.0.0', buildManifestChecksum: `sha256:${'0'.repeat(64)}` },
      config: commerceConfigSchema.parse({ version: 1, store: { id: 'cache-binding', name: 'Cache Binding', currency: 'TWD' }, database: { url }, extensions: [] }),
      secrets: testSecretProvider({}), logger: noopLogger, modules: [], availableExtensions: {},
      cacheBindings: ['platform', 'platform-cache'].map(module => ({ module, bind: scopes => bindings.set(module, scopes) })),
    });
    runtimes.push(runtime);
    await runtime.migrate();
    const platform = bindings.get('platform')!;
    const cache = bindings.get('platform-cache')!;
    await platform.cache.set('same-key', 'platform', { ttlMs: 5_000 });
    await cache.cache.set('same-key', 'cache', { ttlMs: 5_000 });
    await cache.cache.clear();
    await expect(platform.cache.get('same-key')).resolves.toBe('platform');
    await expect(cache.cache.get('same-key')).resolves.toBeUndefined();
    await expect(cache.mutex.runExclusive('scope', { operationId: 'binding-probe', waitTimeoutMs: 500 }, async () => 'bound')).resolves.toBe('bound');
    await expect(runtime.commands.execute('platform.cache.clearOpsCache', {}, {
      actor: runtime.actorForRole('admin'), idempotencyKey: randomUUID(),
    })).resolves.toEqual({ cleared: true });
  });

  it('shares values and invalidation across isolated pools while exact namespace clear preserves siblings', async () => {
    const { firstCache, secondCache } = await setup();
    const catalogA = firstCache.forNamespace('catalog');
    const catalogB = secondCache.forNamespace('catalog');
    const identity = secondCache.forNamespace('identity');

    await catalogA.set('product:42', { name: 'woven bag', stock: 3 }, { ttlMs: 5_000 });
    await identity.set('product:42', { role: 'operator' }, { ttlMs: 5_000 });
    await expect(catalogB.get<{ name: string; stock: number }>('product:42')).resolves.toEqual({ name: 'woven bag', stock: 3 });

    await catalogB.delete('product:42');
    await expect(catalogA.get('product:42')).resolves.toBeUndefined();
    await catalogA.set('another', 'cache-only', { ttlMs: 5_000 });
    await catalogA.clear();
    await expect(catalogB.get('another')).resolves.toBeUndefined();
    await expect(identity.get('product:42')).resolves.toEqual({ role: 'operator' });
  });

  it('observes a CacheScope invalidation performed by an actual separate Node process', async () => {
    const { url, firstCache } = await setup();
    const scope = firstCache.forNamespace('catalog');
    await scope.set('cross-process-cache', { writer: 'parent' }, { ttlMs: 5_000 });
    const child = startInvalidationChild(url);
    const childExited = new Promise<void>((resolveExit, rejectExit) => child.once('exit', code => code === 0 ? resolveExit() : rejectExit(new Error(`Cache child exited with ${code}`))));
    await childExited;
    await expect(scope.get('cross-process-cache')).resolves.toBeUndefined();
  });

  it('shares a cache value and advisory exclusion with an actual separate Node process', async () => {
    const { url, first, firstMutex } = await setup();
    const child = await startMutexChild(url);
    await expect(firstMutex.forNamespace('inventory').runExclusive('cross-process', {
      operationId: 'parent-probe', waitTimeoutMs: 50,
    }, async () => undefined)).rejects.toThrow('timed out');
    const childExited = new Promise<void>((resolveExit, rejectExit) => child.once('exit', (code, signal) => signal === 'SIGTERM' ? resolveExit() : rejectExit(new Error(`Cache child exited with ${code}/${signal}`))));
    child.kill('SIGTERM');
    await childExited;
    await expect(firstMutex.forNamespace('inventory').runExclusive('cross-process', {
      operationId: 'parent-after-child', waitTimeoutMs: 500,
    }, async () => 'released')).resolves.toBe('released');
  });

  it('expires and batch-cleans entries without treating provider failure as a miss', async () => {
    const { first, firstCache } = await setup();
    const cache = firstCache.forNamespace('catalog');
    await cache.set('expired-one', 1, { ttlMs: 20 });
    await cache.set('expired-two', 2, { ttlMs: 20 });
    await pause(40);
    expect(await firstCache.clearExpired()).toBe(1);
    expect(await firstCache.clearExpired()).toBe(1);
    await expect(cache.get('expired-one')).resolves.toBeUndefined();
    await first.close();
    databases.splice(databases.indexOf(first), 1);
    await expect(cache.get('provider-down')).rejects.toThrow();
  });

  it('lets concurrent bounded cleaners split expired rows without blocking or double-counting', async () => {
    const { firstCache, secondCache } = await setup();
    const cache = firstCache.forNamespace('catalog');
    await cache.set('expired-one', 1, { ttlMs: 20 });
    await cache.set('expired-two', 2, { ttlMs: 20 });
    await pause(40);
    const cleared = await Promise.all([
      firstCache.clearExpired({ limit: 1 }),
      secondCache.clearExpired({ limit: 1 }),
    ]);
    expect(cleared.sort()).toEqual([1, 1]);
    await expect(cache.get('expired-one')).resolves.toBeUndefined();
    await expect(cache.get('expired-two')).resolves.toBeUndefined();
  });

  it('rejects invalid scopes, keys and non-expiring entries at the boundary', async () => {
    const { firstCache } = await setup();
    expect(() => firstCache.forNamespace('wrong_namespace')).toThrow(/namespace/);
    const cache = firstCache.forNamespace('catalog');
    await expect(cache.set('', 'value', { ttlMs: 10 })).rejects.toThrow(/key/);
    await expect(cache.set('key', 'value', { ttlMs: 0 })).rejects.toThrow(/ttlMs/);
    await expect(cache.set('key', undefined, { ttlMs: 10 })).rejects.toThrow(/undefined/);
  });
});

describe('PostgreSQL advisory mutex', () => {
  it('serializes the same name across dedicated pools, reports the real backend owner and releases for the next caller', async () => {
    const { firstMutex, secondMutex } = await setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const first = firstMutex.forNamespace('inventory').runExclusive('sku:42', {
      operationId: 'recount:first', waitTimeoutMs: 1_000,
    }, async owner => {
      expect(owner.operationId).toBe('recount:first');
      expect(owner.backendPid).toEqual(expect.any(Number));
      entered.resolve();
      await release.promise;
      return 'first';
    });
    await entered.promise;

    const blocked = vi.fn();
    await expect(secondMutex.forNamespace('inventory').runExclusive('sku:42', {
      operationId: 'recount:blocked', waitTimeoutMs: 40,
    }, async () => { blocked(); return 'blocked'; })).rejects.toThrow(/timed out/);
    expect(blocked).not.toHaveBeenCalled();

    release.resolve();
    await expect(first).resolves.toBe('first');
    await expect(secondMutex.forNamespace('inventory').runExclusive('sku:42', {
      operationId: 'recount:second', waitTimeoutMs: 500,
    }, async () => 'second')).resolves.toBe('second');
  });

  it('allows independent keys concurrently and aborts waiters before their callback runs', async () => {
    const { firstMutex, secondMutex } = await setup();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const holder = firstMutex.forNamespace('inventory').runExclusive('sku:42', {
      operationId: 'holder', waitTimeoutMs: 1_000,
    }, async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    await expect(secondMutex.forNamespace('inventory').runExclusive('sku:43', {
      operationId: 'independent', waitTimeoutMs: 100,
    }, async () => 'ran')).resolves.toBe('ran');

    const abort = new AbortController();
    const callback = vi.fn();
    const waiting = secondMutex.forNamespace('inventory').runExclusive('sku:42', {
      operationId: 'aborted', waitTimeoutMs: 1_000, signal: abort.signal,
    }, async () => { callback(); });
    await pause(20);
    abort.abort(new Error('caller gave up'));
    await expect(waiting).rejects.toThrow('caller gave up');
    expect(callback).not.toHaveBeenCalled();
    gate.resolve();
    await holder;
  });

  it('uses pg_catalog functions even under a hostile search_path and releases on backend termination', async () => {
    const { first, second, firstMutex, secondMutex } = await setup();
    const database = (await first.pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name;
    await first.pool.query(`CREATE SCHEMA trap;
      CREATE FUNCTION trap.pg_try_advisory_lock(integer, integer) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shadow lock'; END $$;
      ALTER DATABASE ${JSON.stringify(database)} SET search_path = trap, pg_catalog, public`);

    const entered = deferred<number>();
    const allowExit = deferred<void>();
    const holder = firstMutex.forNamespace('inventory').runExclusive('sku:42', {
      operationId: 'terminated-owner', waitTimeoutMs: 1_000,
    }, async owner => { entered.resolve(owner.backendPid); await allowExit.promise; });
    const pid = await entered.promise;
    await second.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    allowExit.resolve();
    await expect(holder).rejects.toThrow();
    await expect(secondMutex.forNamespace('inventory').runExclusive('sku:42', {
      operationId: 'after-termination', waitTimeoutMs: 1_000,
    }, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('never runs the callback when an acquisition query exceeds its deadline or is aborted while waiting for a pool client', async () => {
    const { url } = await setup();
    const delayed = new PostgresMutexManager({ url, poolSize: 1, retryIntervalMs: 5 });
    mutexes.push(delayed);
    const pool = mutexPool(delayed);
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      vi.spyOn(client, 'query').mockImplementation(async (...args: Parameters<typeof client.query>) => {
        await pause(60);
        return query(...args);
      });
      return client;
    });
    const callback = vi.fn();
    await expect(delayed.forNamespace('inventory').runExclusive('slow-query', {
      operationId: 'deadline', waitTimeoutMs: 10,
    }, async () => { callback(); })).rejects.toThrow(/timed out/);
    expect(callback).not.toHaveBeenCalled();
    await pause(70); // Let the discarded delayed query settle; it must not create an unhandled rejection.

    const queued = new PostgresMutexManager({ url, poolSize: 1, retryIntervalMs: 5 });
    mutexes.push(queued);
    const held = await mutexPool(queued).connect();
    const abort = new AbortController();
    const started = Date.now();
    const waiting = queued.forNamespace('inventory').runExclusive('pool-queue', {
      operationId: 'pool-abort', waitTimeoutMs: 1_000, signal: abort.signal,
    }, async () => { callback(); });
    await pause(10);
    abort.abort(new Error('pool wait aborted'));
    await expect(waiting).rejects.toThrow('pool wait aborted');
    expect(Date.now() - started).toBeLessThan(200);
    expect(callback).not.toHaveBeenCalled();
    held.release();
    await pause(10); // A late pool checkout is immediately destroyed by acquireClient().
  });

  it('observes an idle dedicated-pool backend failure and can acquire again', async () => {
    const { url, second } = await setup();
    const idleErrors = vi.fn();
    const mutex = new PostgresMutexManager({ url, onIdleError: idleErrors });
    mutexes.push(mutex);
    await mutex.forNamespace('inventory').runExclusive('idle-probe', {
      operationId: 'initial', waitTimeoutMs: 1_000,
    }, async () => undefined);
    const pool = mutexPool(mutex);
    const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await second.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    for (let attempt = 0; attempt < 20 && idleErrors.mock.calls.length === 0; attempt += 1) await pause(10);
    expect(idleErrors).toHaveBeenCalledTimes(1);
    await expect(mutex.forNamespace('inventory').runExclusive('idle-probe', {
      operationId: 'after-idle-failure', waitTimeoutMs: 1_000,
    }, async () => 'reconnected')).resolves.toBe('reconnected');
  });
});
