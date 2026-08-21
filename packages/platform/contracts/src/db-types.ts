import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * 平台唯一的資料庫控制代碼型別。
 * Transaction 物件在 unit-of-work 邊界被 cast 成同型別，之後所有下游程式碼都是強型別。
 * Extension 永遠拿不到這個型別的值（見 extension-sdk 的 ExtensionContext）。
 */
export type DrizzleDb = NodePgDatabase<Record<string, never>>;

/** 交易中的資料庫控制代碼。 */
export type Tx = DrizzleDb;
