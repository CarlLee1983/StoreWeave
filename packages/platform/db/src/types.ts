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

/** SQL-free evidence retained when the owning runtime code is no longer selected. */
export interface MigrationPin {
  readonly id: string;
  readonly phase: Migration['phase'];
  readonly order: number;
  readonly checksum: string;
}

export interface WorkCatalog {
  readonly jobTypes: readonly string[];
  readonly subscriberIds: readonly string[];
  readonly emittedEventNames: readonly string[];
  readonly subscribedEventNames: readonly string[];
}

export interface ModulePin {
  readonly kind: 'module';
  readonly id: string;
  readonly version: string;
  /** Owned PostgreSQL tables (including partitioned tables) and sequences. */
  readonly dataRelations: readonly string[];
  readonly migrationOwner: string | null;
  /** IDs are local to migrationOwner; the SQL ledger uses owner/id. */
  readonly migrations: readonly MigrationPin[];
  readonly work: WorkCatalog;
}

export interface ExtensionPin {
  readonly kind: 'extension';
  readonly id: string;
  readonly version: string;
  readonly migrations: readonly [];
  readonly work: WorkCatalog;
}

export type ReleaseOwnerPin = ModulePin | ExtensionPin;

/** Compatibility metadata committed with the effective release; contains no runtime objects. */
export interface ExtensionRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly platformVersion: string;
  readonly permissions: readonly string[];
}

export interface ReleaseSelection {
  readonly releaseId: string;
  readonly releaseVersion: string;
  readonly baseVersion: string;
  readonly buildManifestChecksum: string;
  readonly activeOwners: readonly ReleaseOwnerPin[];
}

export interface EffectiveReleaseManifest {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly releaseVersion: string;
  readonly baseVersion: string;
  readonly buildManifestChecksum: string;
  readonly owners: readonly { readonly state: 'active' | 'disabled'; readonly owner: ReleaseOwnerPin }[];
}

export function sqlMigration(id: string, phase: Migration['phase'], up: string): Migration {
  return { id, phase, up };
}
