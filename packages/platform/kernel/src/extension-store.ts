import { sql } from 'drizzle-orm';
import type { Database } from '@storeweave/db';
import type { ExtensionStore, ExtensionStoreEntry } from '@storeweave/extension-sdk';

/**
 * 以資料庫為後端的 Extension 儲存，永遠以 extension_id 過濾。
 * Extension 拿到的是這個介面的實例，而不是資料庫連線 —— 它無法讀寫別人的資料。
 */
export class DbExtensionStore implements ExtensionStore {
  constructor(private readonly database: Database, private readonly extensionId: string) {}

  async get<T>(key: string): Promise<T | null> {
    const res = await this.database.db.execute<{ value: T }>(sql`
      SELECT value FROM platform_extension_state WHERE extension_id = ${this.extensionId} AND key = ${key}
    `);
    return res.rows[0]?.value ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.database.db.execute(sql`
      INSERT INTO platform_extension_state (extension_id, key, value, updated_at)
      VALUES (${this.extensionId}, ${key}, ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (extension_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
  }

  async delete(key: string): Promise<void> {
    await this.database.db.execute(sql`
      DELETE FROM platform_extension_state WHERE extension_id = ${this.extensionId} AND key = ${key}
    `);
  }

  async list<T>(prefix = '', limit = 100): Promise<ExtensionStoreEntry<T>[]> {
    const res = await this.database.db.execute<{ key: string; value: T; updated_at: Date }>(sql`
      SELECT key, value, updated_at FROM platform_extension_state
      WHERE extension_id = ${this.extensionId} AND key LIKE ${`${prefix}%`}
      ORDER BY updated_at DESC LIMIT ${limit}
    `);
    return res.rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }

  async mutate<T>(key: string, fn: (current: T | null) => T): Promise<T> {
    return this.database.transaction(async (tx) => {
      const res = await tx.execute<{ value: T }>(sql`
        SELECT value FROM platform_extension_state
        WHERE extension_id = ${this.extensionId} AND key = ${key} FOR UPDATE
      `);
      const next = fn(res.rows[0]?.value ?? null);
      await tx.execute(sql`
        INSERT INTO platform_extension_state (extension_id, key, value, updated_at)
        VALUES (${this.extensionId}, ${key}, ${JSON.stringify(next)}::jsonb, now())
        ON CONFLICT (extension_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `);
      return next;
    });
  }
}
