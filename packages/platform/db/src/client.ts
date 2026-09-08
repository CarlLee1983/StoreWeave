import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { DatabaseOperationTimeoutError, type DrizzleDb, type Tx } from '@storeweave/contracts';

export interface DatabaseOptions {
  url: string;
  poolSize?: number;
  ssl?: boolean;
  statementTimeoutMs?: number;
  /** node-postgres closes a TCP connection establishment that never completes. */
  connectionTimeoutMs?: number;
}

/**
 * 平台唯一的資料庫進入點。核心模組透過 `transaction()` 取得 Tx；
 * Extension 拿不到這個物件（Extension SDK 不暴露它）。
 */
export class Database {
  readonly pool: Pool;
  readonly db: DrizzleDb;

  constructor(options: DatabaseOptions) {
    const cfg: PoolConfig = {
      connectionString: options.url,
      max: options.poolSize ?? 10,
      ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    };
    this.pool = new Pool(cfg);
    this.db = drizzle(this.pool) as DrizzleDb;
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(tx as unknown as Tx));
  }

  /**
   * A worker acknowledgement/heartbeat must have a bounded *whole* database
   * operation, not only a PostgreSQL statement timeout.  On expiry the leased
   * client is discarded, which terminates its session and rolls back an open
   * transaction.  The resulting outcome is deliberately uncertain to the
   * caller, so worker code must fail-stop rather than issue another mutation.
   */
  async boundedTransaction<T>(timeoutMs: number, operation: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid database timeout: ${timeoutMs}`);
    const deadline = Date.now() + timeoutMs;
    const client = await this.acquireBoundedClient(deadline, timeoutMs, operation);
    let released = false;
    const discard = (error: Error) => {
      if (released) return;
      // Pool.release(error) removes this connection from circulation. This is
      // essential: a timed-out socket must not retain an open transaction or
      // return to another worker.
      client.release(error);
      released = true;
    };
    try {
      await this.beforeDeadline(deadline, timeoutMs, operation, () => client.query('BEGIN'), discard);
      // Server-side ceiling for blocked statements; the same absolute deadline
      // below also covers callback work and an unresponsive client socket.
      await this.beforeDeadline(deadline, timeoutMs, operation,
        () => client.query(`SET LOCAL statement_timeout = ${this.remaining(deadline, timeoutMs, operation)}`), discard);
      const tx = drizzle(client) as unknown as Tx;
      const result = await this.beforeDeadline(deadline, timeoutMs, operation, () => fn(tx), discard);
      await this.beforeDeadline(deadline, timeoutMs, operation, () => client.query('COMMIT'), discard);
      return result;
    } catch (error) {
      // Rollback itself can hang on a broken socket; discard rather than
      // returning a client that may still carry an in-flight operation.
      discard(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  private remaining(deadline: number, timeoutMs: number, operation: string): number {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new DatabaseOperationTimeoutError(timeoutMs, operation);
    return milliseconds;
  }

  private async beforeDeadline<T>(
    deadline: number, timeoutMs: number, operation: string, action: () => Promise<T>, onTimeout: (error: Error) => void,
  ): Promise<T> {
    const remaining = this.remaining(deadline, timeoutMs, operation);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new DatabaseOperationTimeoutError(timeoutMs, operation);
        onTimeout(error);
        reject(error);
      }, remaining);
    });
    try { return await Promise.race([Promise.resolve().then(action), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private async acquireBoundedClient(deadline: number, timeoutMs: number, operation: string): Promise<PoolClient> {
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const acquiring = this.pool.connect();
    // A queued pool acquisition cannot be cancelled by pg. If it arrives after
    // expiry, immediately destroy it before user code can run on it.
    void acquiring.then(client => {
      if (expired) client.release(new DatabaseOperationTimeoutError(timeoutMs, operation));
    }, () => undefined);
    try {
      return await Promise.race([
        acquiring,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new DatabaseOperationTimeoutError(timeoutMs, operation));
          }, this.remaining(deadline, timeoutMs, operation));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      await this.db.execute(sql`select 1`);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
