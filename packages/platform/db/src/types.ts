/** 一個 migration 步驟。SQL 內嵌在 TS，因此 bundle 後的 release 不需要額外檔案。 */
export interface Migration {
  /** 模組內唯一、單調遞增，例如 `0001_init`。 */
  readonly id: string;
  readonly up: string;
  /**
   * Expand–Migrate–Contract：`phase` 用來標示這個 migration 屬於哪個階段。
   * `expand` 必須向後相容（舊版程式可繼續運作），`contract` 只能在舊版不再需要回滾後才發布。
   */
  readonly phase: 'expand' | 'migrate' | 'contract';
}

export interface MigrationSet {
  /** 模組名稱，用來組成全域唯一 migration id：`<module>/<id>`。 */
  readonly module: string;
  readonly migrations: readonly Migration[];
}

export function sqlMigration(id: string, phase: Migration['phase'], up: string): Migration {
  return { id, phase, up };
}
