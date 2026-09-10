import type {
  CommandDescriptor, CommandHandler, DomainEventDescriptor, EventHandlerFn, QueryDescriptor, QueryHandler,
} from '@storeweave/contracts';
import type { MigrationSet } from '@storeweave/db';
import type { PermissionDefinition, PolicyDefinition } from '@storeweave/authorization';
import type { JobHandler } from '@storeweave/jobs';
import type { NotificationsPort } from '@storeweave/notifications';
import type { PageMap } from './page';
import type { ScheduleDeclaration } from './schedule-spec';
import type { JobPayloadContract } from './job-registry';

/**
 * Base capabilities a module cannot construct for itself because the runtime
 * owns their resources. They are handed over once, before any handler runs.
 */
export interface PlatformPorts {
  readonly notifications: NotificationsPort;
}

export interface ModuleDependency {
  readonly name: string;
  readonly versionRange: string;
}

export interface ModuleCapabilityRequirement {
  readonly from: string;
  readonly versionRange: string;
  readonly capability: string;
}

/** An explicit constructor argument with provenance; no registry or runtime lookup. */
export interface BoundModuleCapability<T> {
  readonly from: string;
  readonly capability: string;
  readonly value: T;
}

export function bindModuleCapability<T>(from: string, capability: string, value: T): BoundModuleCapability<T> {
  return Object.freeze({ from, capability, value });
}

export interface ModuleCommandRequirement {
  readonly from: string;
  readonly name: string;
  readonly version: number;
}

/**
 * 平台模組的組裝契約。領域由模組自己決定；Commerce Core 是第一組實作，不是唯一合法集合。
 * 模組之間只透過彼此匯出的 service 函式互動，絕不直接讀寫對方的資料表。
 */
export interface PlatformModule {
  /** Stable id, including the persisted event subscriber id. */
  readonly name: string;
  readonly version: string;
  /** Base ABI compatibility, independent of the module package version. */
  readonly baseVersionRange: string;
  /** Static dependencies determine registration order; optional present modules are checked too. */
  readonly dependencies?: {
    readonly required?: readonly ModuleDependency[];
    readonly optional?: readonly ModuleDependency[];
  };
  /** Invocation relationships through explicit service ports, not initialization edges or a locator. */
  readonly capabilities?: {
    readonly provides?: readonly string[];
    readonly required?: readonly ModuleCapabilityRequirement[];
    readonly optional?: readonly ModuleCapabilityRequirement[];
    readonly bound?: readonly BoundModuleCapability<unknown>[];
  };
  /** Collision-checked ownership declarations. Trusted Node modules are not SQL sandboxes. */
  readonly data?: { readonly owns: readonly string[] };
  readonly migrations?: MigrationSet;
  readonly permissions?: readonly PermissionDefinition[];
  readonly events?: readonly DomainEventDescriptor[];
  readonly commands?: readonly { descriptor: CommandDescriptor; handler: CommandHandler }[];
  readonly queries?: readonly { descriptor: QueryDescriptor; handler: QueryHandler }[];
  /**
   * 背景工作。帶 `schedule` 的會被登記成週期性工作，由 Worker 每一輪確保當下這個切片
   * 已經排入（見 `recurring.ts`）——模組自己不需要處理去重鍵或續排。
   */
  readonly jobs?: readonly { type: string; handler: JobHandler; jobContractV1?: JobPayloadContract; schedule?: ScheduleDeclaration }[];
  /**
   * 對別的模組的事件做出反應。投遞經過 Outbox 與背景工作，因此訂閱者的失敗
   * 不會讓發出事件的那筆交易回滾——「發券失敗不影響註冊成功」是這個機制的結果，
   * 不是額外的處理。訂閱者識別就是模組名稱。
   */
  readonly subscribers?: readonly {
    eventName: string;
    handler: EventHandlerFn;
    maxAttempts?: number;
    /** Exact foreign commands granted to this subscriber; own commands are implicit. */
    commands?: readonly ModuleCommandRequirement[];
  }[];
  readonly policies?: readonly PolicyDefinition[];
  /**
   * 這個模組帶來的前台頁面。平台只知道「頁面」，領域由模組自己宣告（ADR 0045）；
   * 沒有前台的模組不宣告這個欄位。
   */
  readonly pages?: PageMap;
  /**
   * One-shot composition hook. Modules are built before the runtime exists, so a
   * module that notifies people receives the capability here rather than looking
   * it up: there is still no registry to ask, and the edge stays visible.
   */
  readonly bindPorts?: (ports: PlatformPorts) => void;
}

export function defineModule(mod: PlatformModule): PlatformModule {
  return mod;
}
