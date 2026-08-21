/**
 * Extension 專屬儲存。以 extension id 隔離；
 * Extension 不會拿到資料庫連線，也無法碰其他模組或其他 Extension 的資料。
 */
export interface ExtensionStoreEntry<T = unknown> {
  key: string;
  value: T;
  updatedAt: Date;
}

export interface ExtensionStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T = unknown>(prefix?: string, limit?: number): Promise<ExtensionStoreEntry<T>[]>;
  /** 讀-改-寫，於單一交易內完成，避免併發覆寫。 */
  mutate<T = unknown>(key: string, fn: (current: T | null) => T): Promise<T>;
}
