import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * The worker could not establish a bounded database outcome.  In particular,
 * callers must not retry an acknowledgement after this error: the server may
 * have accepted it while the client lost its response.
 */
export class DatabaseOperationTimeoutError extends Error {
  constructor(readonly timeoutMs: number, operation: string) {
    super(`Database operation timed out after ${timeoutMs}ms: ${operation}`);
    this.name = 'DatabaseOperationTimeoutError';
  }
}

/**
 * 平台唯一的資料庫控制代碼型別。
 * Transaction 物件在 unit-of-work 邊界被 cast 成同型別，之後所有下游程式碼都是強型別。
 * Extension 永遠拿不到這個型別的值（見 extension-sdk 的 ExtensionContext）。
 */
export type DrizzleDb = NodePgDatabase<Record<string, never>>;

/** 交易中的資料庫控制代碼。 */
export type Tx = DrizzleDb;
