import type { CommandDescriptor, CommandHandler, DomainEventDescriptor, QueryDescriptor, QueryHandler } from '@storeweave/contracts';
import type { MigrationSet } from '@storeweave/db';
import type { PermissionDefinition, PolicyDefinition } from '@storeweave/authorization';
import type { JobHandler } from '@storeweave/jobs';
import type { RecurringJob } from './recurring';

/**
 * 平台模組的組裝契約。領域由模組自己決定；Commerce Core 是第一組實作，不是唯一合法集合。
 * 模組之間只透過彼此匯出的 service 函式互動，絕不直接讀寫對方的資料表。
 */
export interface PlatformModule {
  readonly name: string;
  readonly migrations?: MigrationSet;
  readonly permissions?: readonly PermissionDefinition[];
  readonly events?: readonly DomainEventDescriptor[];
  readonly commands?: readonly { descriptor: CommandDescriptor; handler: CommandHandler }[];
  readonly queries?: readonly { descriptor: QueryDescriptor; handler: QueryHandler }[];
  /**
   * 背景工作。帶 `schedule` 的會被登記成週期性工作，由 Worker 每一輪確保當下這個切片
   * 已經排入（見 `recurring.ts`）——模組自己不需要處理去重鍵或續排。
   */
  readonly jobs?: readonly { type: string; handler: JobHandler; schedule?: Pick<RecurringJob, 'everyMs'> }[];
  readonly policies?: readonly PolicyDefinition[];
}

export function defineModule(mod: PlatformModule): PlatformModule {
  return mod;
}
