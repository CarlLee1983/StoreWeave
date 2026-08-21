import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';

export interface DatabaseOptions {
  url: string;
  poolSize?: number;
  ssl?: boolean;
  statementTimeoutMs?: number;
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
    };
    this.pool = new Pool(cfg);
    this.db = drizzle(this.pool) as DrizzleDb;
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(tx as unknown as Tx));
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
