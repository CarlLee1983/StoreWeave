import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Keyv, { type KeyvStoreAdapter } from 'keyv';
import { Pool, type PoolClient } from 'pg';
import { sqlMigration, type MigrationSet } from '@storeweave/db';

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const MAX_KEY_LENGTH = 512;
const UNLOCK_TIMEOUT_MS = 10_000;

export const cacheMigrations: MigrationSet = {
  module: 'platform-cache',
  migrations: [sqlMigration('0001_init', 'expand', `
CREATE UNLOGGED TABLE IF NOT EXISTS public.platform_cache (
  namespace  varchar(64) NOT NULL,
  key        varchar(512) NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS platform_cache_expires_idx
  ON public.platform_cache (expires_at);
`)],
};

export interface CacheSetOptions { readonly ttlMs: number; }

export interface CacheScope {
  readonly namespace: string;
  get<Value>(key: string): Promise<Value | undefined>;
  set<Value>(key: string, value: Value, options: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Deletes entries for this exact namespace and no other namespace. */
  clear(): Promise<void>;
}

export interface CacheManager {
  forNamespace(namespace: string): CacheScope;
  /** Bounded, concurrent-safe expiry cleanup. Calling it repeatedly is safe. */
  clearExpired(options?: { readonly limit?: number }): Promise<number>;
  close(): Promise<void>;
}

export interface LockOwner {
  /** Caller-provided correlation identity; advisory-lock ownership is the PostgreSQL session below. */
  readonly operationId: string;
  readonly backendPid: number;
  readonly acquiredAt: Date;
}

export interface MutexScope {
  /**
   * Calls operation only while this process owns the named PostgreSQL advisory lock.
   * A timeout or aborted wait rejects before operation runs; no lease TTL is inferred.
   */
  runExclusive<T>(key: string, options: {
    readonly operationId: string;
    readonly waitTimeoutMs: number;
    readonly signal?: AbortSignal;
  }, operation: (owner: LockOwner) => Promise<T>): Promise<T>;
}

export interface MutexManager {
  forNamespace(namespace: string): MutexScope;
  close(): Promise<void>;
}

export interface PostgresCacheOptions {
  readonly cleanupBatchSize?: number;
  readonly cleanupIntervalMs?: number;
  readonly onCleanupError?: (error: unknown) => void;
}
export interface PostgresMutexOptions {
  readonly url: string;
  readonly ssl?: boolean;
  readonly poolSize?: number;
  /** Bounds an in-flight TCP/PostgreSQL connection attempt. Runtime shutdown is bounded by its lifecycle deadline. */
  readonly connectionTimeoutMs?: number;
  readonly retryIntervalMs?: number;
  /** Idle backend failures must be observed; they are never allowed to become an unhandled Pool error. */
  readonly onIdleError?: (error: Error) => void;
}

interface StoredKeyvEntry { readonly expires?: number; }

function assertNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) throw new Error(`Invalid cache namespace: must match ${NAMESPACE_PATTERN.source}`);
}

function assertKey(key: string): void {
  if (!key || key.length > MAX_KEY_LENGTH) throw new Error(`Invalid cache key: must be 1 to ${MAX_KEY_LENGTH} characters`);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${field}: expected a positive integer`);
}

/**
 * Keyv core handles serialization and TTL compatibility. The official PostgreSQL
 * adapter is deliberately not used: it owns a global pool, creates DDL itself,
 * and cannot provide a DB-visible expiry cleanup or exact namespace clear.
 */
class PostgresKeyvStore extends EventEmitter implements KeyvStoreAdapter {
  readonly opts = {};
  namespace?: string;

  constructor(private readonly pool: Pool, namespace: string) {
    super();
    this.namespace = namespace;
  }

  private currentNamespace(): string {
    if (!this.namespace) throw new Error('Cache store has no namespace');
    return this.namespace;
  }

  async get<Value>(key: string): Promise<Value | undefined> {
    assertKey(key);
    const { rows } = await this.pool.query<{ value: string }>(`SELECT value
      FROM public.platform_cache
      WHERE namespace = $1 AND key = $2 AND expires_at > pg_catalog.clock_timestamp()`, [this.currentNamespace(), key]);
    return rows[0]?.value as Value | undefined;
  }

  async set(key: string, value: string): Promise<void> {
    assertKey(key);
    let entry: StoredKeyvEntry;
    try { entry = JSON.parse(value) as StoredKeyvEntry; }
    catch { throw new Error('Cache adapter received a non-JSON Keyv value'); }
    const expires = entry.expires;
    if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= Date.now()) {
      throw new Error('Cache entries require a future finite TTL');
    }
    await this.pool.query(`INSERT INTO public.platform_cache (namespace, key, value, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (namespace, key) DO UPDATE
      SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = pg_catalog.clock_timestamp()`,
    [this.currentNamespace(), key, value, new Date(expires)]);
  }

  async delete(key: string): Promise<boolean> {
    assertKey(key);
    const result = await this.pool.query('DELETE FROM public.platform_cache WHERE namespace = $1 AND key = $2',
      [this.currentNamespace(), key]);
    return result.rowCount === 1;
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM public.platform_cache WHERE namespace = $1', [this.currentNamespace()]);
  }
}

class ScopedCache implements CacheScope {
  readonly namespace: string;
  private readonly keyv: Keyv;

  constructor(private readonly manager: PostgresCacheManager, namespace: string, pool: Pool) {
    assertNamespace(namespace);
    this.namespace = namespace;
    this.keyv = new Keyv({
      namespace,
      useKeyPrefix: false,
      store: new PostgresKeyvStore(pool, namespace),
      throwOnErrors: true,
    });
  }

  async get<Value>(key: string): Promise<Value | undefined> {
    this.manager.assertOpen();
    assertKey(key);
    return this.keyv.get<Value>(key);
  }

  async set<Value>(key: string, value: Value, options: CacheSetOptions): Promise<void> {
    this.manager.assertOpen();
    assertKey(key);
    assertPositiveInteger(options.ttlMs, 'cache ttlMs');
    if (value === undefined) throw new Error('Cache cannot store undefined; it denotes a cache miss');
    const stored = await this.keyv.set(key, value, options.ttlMs);
    if (!stored) throw new Error('Cache write was not accepted by its provider');
  }

  async delete(key: string): Promise<boolean> {
    this.manager.assertOpen();
    assertKey(key);
    return this.keyv.delete(key);
  }

  async clear(): Promise<void> {
    this.manager.assertOpen();
    await this.keyv.clear();
  }
}

export class PostgresCacheManager implements CacheManager {
  private readonly scopes = new Map<string, ScopedCache>();
  private readonly cleanupBatchSize: number;
  private readonly cleanupIntervalMs: number;
  private readonly onCleanupError: (error: unknown) => void;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly pool: Pool, options: PostgresCacheOptions = {}) {
    this.cleanupBatchSize = options.cleanupBatchSize ?? 500;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    this.onCleanupError = options.onCleanupError ?? (() => undefined);
    assertPositiveInteger(this.cleanupBatchSize, 'cache cleanupBatchSize');
    assertPositiveInteger(this.cleanupIntervalMs, 'cache cleanupIntervalMs');
  }

  forNamespace(namespace: string): CacheScope {
    this.assertOpen();
    assertNamespace(namespace);
    let scope = this.scopes.get(namespace);
    if (!scope) {
      scope = new ScopedCache(this, namespace, this.pool);
      this.scopes.set(namespace, scope);
    }
    return scope;
  }

  async clearExpired(options: { readonly limit?: number } = {}): Promise<number> {
    this.assertOpen();
    const limit = options.limit ?? this.cleanupBatchSize;
    assertPositiveInteger(limit, 'cache cleanup limit');
    const result = await this.pool.query(`WITH expired AS (
      SELECT namespace, key FROM public.platform_cache
      WHERE expires_at <= pg_catalog.clock_timestamp()
      ORDER BY expires_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.platform_cache cache
    USING expired
    WHERE cache.namespace = expired.namespace AND cache.key = expired.key`, [limit]);
    return result.rowCount ?? 0;
  }

  /** Starts only after migrations and release activation have made the table available. */
  startCleanup(): void {
    this.assertOpen();
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.clearExpired().catch(error => {
        try { this.onCleanupError(error); }
        catch { /* An observability failure must not become an unhandled timer rejection. */ }
      });
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }
  assertOpen(): void { if (this.closed) throw new Error('Cache manager is closed'); }
}

interface MemoryEntry { readonly value: string; readonly expiresAt: number; }

class MemoryCacheScope implements CacheScope {
  constructor(private readonly manager: MemoryCacheManager, readonly namespace: string) {}

  async get<Value>(key: string): Promise<Value | undefined> {
    this.manager.assertOpen();
    assertKey(key);
    const entry = this.manager.entry(this.namespace, key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.manager.deleteEntry(this.namespace, key);
      return undefined;
    }
    const deserialize = memoryCodec.deserialize;
    if (!deserialize) throw new Error('Cache test double has no Keyv deserializer');
    const decoded = await deserialize(entry.value);
    if (!decoded) return undefined;
    return decoded.value as Value;
  }

  async set<Value>(key: string, value: Value, options: CacheSetOptions): Promise<void> {
    this.manager.assertOpen();
    assertKey(key);
    assertPositiveInteger(options.ttlMs, 'cache ttlMs');
    if (value === undefined) throw new Error('Cache cannot store undefined; it denotes a cache miss');
    let serialized: string | undefined;
    const serialize = memoryCodec.serialize;
    if (!serialize) throw new Error('Cache test double has no Keyv serializer');
    try { serialized = await serialize({ value, expires: Date.now() + options.ttlMs }) as string; }
    catch { throw new Error('Cache test double could not serialize this value'); }
    if (serialized === undefined) throw new Error('Cache test double could not serialize this value');
    this.manager.setEntry(this.namespace, key, { value: serialized, expiresAt: Date.now() + options.ttlMs });
  }

  async delete(key: string): Promise<boolean> {
    this.manager.assertOpen();
    assertKey(key);
    return this.manager.deleteEntry(this.namespace, key);
  }

  async clear(): Promise<void> {
    this.manager.assertOpen();
    this.manager.clearNamespace(this.namespace);
  }
}

/** Uses the same default Keyv codec as the PostgreSQL path, without becoming a runtime fallback. */
const memoryCodec = new Keyv({ useKeyPrefix: false });

/** In-memory test double. It is never selected by runtime configuration or production fallback. */
export class MemoryCacheManager implements CacheManager {
  private readonly entries = new Map<string, Map<string, MemoryEntry>>();
  private readonly scopes = new Map<string, MemoryCacheScope>();
  private closed = false;

  forNamespace(namespace: string): CacheScope {
    this.assertOpen();
    assertNamespace(namespace);
    let scope = this.scopes.get(namespace);
    if (!scope) {
      scope = new MemoryCacheScope(this, namespace);
      this.scopes.set(namespace, scope);
    }
    return scope;
  }

  async clearExpired(options: { readonly limit?: number } = {}): Promise<number> {
    this.assertOpen();
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    assertPositiveInteger(limit, 'cache cleanup limit');
    let cleared = 0;
    const now = Date.now();
    for (const [namespace, values] of this.entries) {
      for (const [key, entry] of values) {
        if (entry.expiresAt <= now) {
          values.delete(key);
          cleared += 1;
          if (cleared === limit) return cleared;
        }
      }
      if (values.size === 0) this.entries.delete(namespace);
    }
    return cleared;
  }

  async close(): Promise<void> { this.closed = true; }
  assertOpen(): void { if (this.closed) throw new Error('Cache manager is closed'); }
  entry(namespace: string, key: string): MemoryEntry | undefined { return this.entries.get(namespace)?.get(key); }
  setEntry(namespace: string, key: string, entry: MemoryEntry): void {
    let values = this.entries.get(namespace);
    if (!values) { values = new Map(); this.entries.set(namespace, values); }
    values.set(key, entry);
  }
  deleteEntry(namespace: string, key: string): boolean { return this.entries.get(namespace)?.delete(key) ?? false; }
  clearNamespace(namespace: string): void { this.entries.delete(namespace); }
}

function advisoryParts(namespace: string, key: string): readonly [number, number] {
  const digest = createHash('sha256').update(`storeweave/cache-mutex/v1/${namespace}/${key}`, 'utf8').digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

class ScopedMutex implements MutexScope {
  constructor(private readonly manager: PostgresMutexManager, private readonly namespace: string) {}
  runExclusive<T>(key: string, options: { readonly operationId: string; readonly waitTimeoutMs: number; readonly signal?: AbortSignal }, operation: (owner: LockOwner) => Promise<T>): Promise<T> {
    assertKey(key);
    return this.manager.runExclusive(this.namespace, key, options, operation);
  }
}

export class PostgresMutexManager implements MutexManager {
  private readonly scopes = new Map<string, ScopedMutex>();
  private readonly pool: Pool;
  private readonly retryIntervalMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly onIdleError: (error: Error) => void;
  private closing: Promise<void> | undefined;

  constructor(options: PostgresMutexOptions) {
    if (!options.url) throw new Error('Mutex PostgreSQL URL is required');
    const size = options.poolSize ?? 2;
    this.retryIntervalMs = options.retryIntervalMs ?? 25;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 5_000;
    this.onIdleError = options.onIdleError ?? (() => undefined);
    assertPositiveInteger(size, 'mutex poolSize');
    assertPositiveInteger(this.retryIntervalMs, 'mutex retryIntervalMs');
    assertPositiveInteger(this.connectionTimeoutMs, 'mutex connectionTimeoutMs');
    this.pool = new Pool({
      connectionString: options.url, ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
      max: size, connectionTimeoutMillis: this.connectionTimeoutMs,
    });
    this.pool.on('error', error => {
      try { this.onIdleError(error); }
      catch { /* Pool error handlers must not themselves turn an idle disconnect into a crash. */ }
    });
  }

  forNamespace(namespace: string): MutexScope {
    this.assertOpen();
    assertNamespace(namespace);
    let scope = this.scopes.get(namespace);
    if (!scope) {
      scope = new ScopedMutex(this, namespace);
      this.scopes.set(namespace, scope);
    }
    return scope;
  }

  async runExclusive<T>(namespace: string, key: string, options: {
    readonly operationId: string; readonly waitTimeoutMs: number; readonly signal?: AbortSignal;
  }, operation: (owner: LockOwner) => Promise<T>): Promise<T> {
    this.assertOpen();
    assertNamespace(namespace);
    assertKey(key);
    if (!OPERATION_ID_PATTERN.test(options.operationId)) throw new Error(`Invalid mutex operationId: must match ${OPERATION_ID_PATTERN.source}`);
    assertPositiveInteger(options.waitTimeoutMs, 'mutex waitTimeoutMs');
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Mutex wait aborted');
    const deadline = Date.now() + options.waitTimeoutMs;
    const [first, second] = advisoryParts(namespace, key);
    const client = await this.acquireClient(deadline, options.signal);
    if (!client) throw new Error(`Mutex acquisition timed out after ${options.waitTimeoutMs}ms`);
    let locked = false;
    let completed = false;
    let connectionFailure: Error | undefined;
    const onConnectionError = (error: Error) => { connectionFailure = error; };
    client.on('error', onConnectionError);
    try {
      do {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('Mutex wait aborted');
        this.assertOpen();
        const result = await this.beforeDeadline(() => client.query<{ acquired: boolean; backend_pid: number }>(
          'SELECT pg_catalog.pg_try_advisory_lock($1::integer, $2::integer) AS acquired, pg_catalog.pg_backend_pid() AS backend_pid', [first, second]),
        deadline, options.signal, 'Mutex acquisition');
        if (result.rows[0]?.acquired) {
          locked = true;
          if (Date.now() >= deadline || options.signal?.aborted) {
            throw options.signal?.reason ?? new Error(`Mutex acquisition timed out after ${options.waitTimeoutMs}ms`);
          }
          this.assertOpen();
          const owner: LockOwner = { operationId: options.operationId, backendPid: result.rows[0].backend_pid, acquiredAt: new Date() };
          let operationStarted = false;
          let operationFailure: unknown;
          try {
            const output = await operation(owner);
            return output;
          }
          catch (error) { operationStarted = true; operationFailure = error; throw error; }
          finally {
            try {
              if (connectionFailure) throw connectionFailure;
              const unlocked = await this.beforeDeadline(
                () => client.query<{ unlocked: boolean }>(
                  'SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer) AS unlocked', [first, second]),
                Date.now() + UNLOCK_TIMEOUT_MS, undefined, 'Mutex release',
              );
              if (unlocked.rows[0]?.unlocked !== true) throw new Error('Mutex advisory lock was not held by its session');
              locked = false;
              completed = true;
            } catch (unlockFailure) {
              if (operationStarted) throw new AggregateError([operationFailure, unlockFailure], 'Mutex operation and unlock failed');
              throw unlockFailure;
            }
          }
        }
        await this.waitUntil(deadline, options.signal);
      } while (Date.now() < deadline);
      throw new Error(`Mutex acquisition timed out after ${options.waitTimeoutMs}ms`);
    } finally {
      if (completed && !connectionFailure) {
        client.removeListener('error', onConnectionError);
        client.release();
      } else {
        // A terminated backend can emit after its query rejects. Retain the
        // listener until pg has finished destroying this uncertain session.
        client.once('end', () => client.removeListener('error', onConnectionError));
        client.release(true);
      }
    }
  }

  async close(): Promise<void> {
    this.closing ??= this.pool.end();
    return this.closing;
  }

  private assertOpen(): void { if (this.closing) throw new Error('Mutex manager is closing'); }

  private async acquireClient(deadline: number, signal?: AbortSignal): Promise<PoolClient | undefined> {
    const connecting = this.pool.connect();
    let expired = false;
    void connecting.then(client => { if (expired) client.release(true); }, () => undefined);
    if (signal?.aborted) { expired = true; throw signal.reason ?? new Error('Mutex wait aborted'); }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { expired = true; return undefined; }
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([connecting, new Promise<undefined>(resolve => {
        timer = setTimeout(() => { expired = true; resolve(undefined); }, remaining);
      }), new Promise<never>((_resolve, reject) => {
        abort = () => { expired = true; reject(signal?.reason ?? new Error('Mutex wait aborted')); };
        signal?.addEventListener('abort', abort, { once: true });
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }

  private async beforeDeadline<T>(action: () => Promise<T>, deadline: number, signal: AbortSignal | undefined, operation: string): Promise<T> {
    if (signal?.aborted) throw signal.reason ?? new Error('Mutex wait aborted');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${operation} timed out`);
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([action(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out`)), remaining);
      }), new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason ?? new Error('Mutex wait aborted'));
        signal?.addEventListener('abort', abort, { once: true });
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }

  private async waitUntil(deadline: number, signal?: AbortSignal): Promise<void> {
    const delay = Math.min(this.retryIntervalMs, Math.max(1, deadline - Date.now()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, delay);
      const abort = () => done(signal?.reason ?? new Error('Mutex wait aborted'));
      function done(error?: unknown) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
