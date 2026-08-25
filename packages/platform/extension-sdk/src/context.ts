import type { DomainEvent, Logger } from '@storeweave/contracts';
import type { ExtensionStore } from './store';
import type { AnyProvider, ProviderKind } from './providers';

export interface ExtensionCommandApi {
  /**
   * 執行核心或其他 Extension 的 Command。
   * 只允許 manifest.permissions 涵蓋的 Command；越權會拋 FORBIDDEN。
   */
  execute<O = unknown>(name: string, input: unknown, options?: { idempotencyKey?: string; correlationId?: string }): Promise<O>;
}

export interface ExtensionQueryApi {
  execute<O = unknown>(name: string, input: unknown, options?: { correlationId?: string }): Promise<O>;
}

export interface ExtensionJobApi {
  /** 排入自己的背景工作。dedupeKey 用來保證外部副作用只發生一次。 */
  enqueue(input: { type: string; payload: unknown; dedupeKey?: string; runAt?: Date; maxAttempts?: number }): Promise<{ id: string; deduped: boolean }>;
  /** 僅重送已進死信佇列的工作；適合可能造成外部副作用的人工重試。 */
  retryDead(jobId: string): Promise<void>;
  /**
   * 人工重送任意狀態的既有工作。僅適用於 handler 本身有安全重播語意的情況；
   * carrier create 等外部副作用應改用 retryDead()。
   */
  requeue(jobId: string): Promise<void>;
}

/**
 * Extension 唯一能拿到的執行環境。
 * 這裡刻意沒有：資料庫連線、交易物件、其他模組的 repository、全域 registry 的寫入權。
 */
export interface ExtensionContext<TConfig = unknown> {
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly platformVersion: string;
  readonly config: TConfig;
  readonly logger: Logger;
  readonly commands: ExtensionCommandApi;
  readonly queries: ExtensionQueryApi;
  readonly jobs: ExtensionJobApi;
  readonly store: ExtensionStore;
  /** 只讀取 manifest 宣告過的 provider kind。 */
  getProvider<T extends AnyProvider>(kind: ProviderKind, id?: string): T;
  /** 機密只從環境變數／Secret Provider 取得，永遠不會出現在 manifest 或設定檔。 */
  secret(name: string): string | undefined;
  now(): Date;
}

export type ExtensionEventHandler<P = unknown> = (
  event: DomainEvent<P>,
  ctx: ExtensionContext<any>,
) => Promise<void>;

export type ExtensionJobHandler = (
  payload: unknown,
  ctx: ExtensionContext<any> & { attempt: number; jobId: string },
) => Promise<void>;
