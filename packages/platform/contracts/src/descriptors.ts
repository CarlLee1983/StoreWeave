import type { ZodType, ZodTypeDef } from 'zod';

/** 允許 schema 的輸入型別與輸出型別不同（default / coerce 會造成差異）。 */
export type Schema<T> = ZodType<T, ZodTypeDef, any>;
import type { Actor } from './actor';
import type { DomainEvent } from './events';
import type { Logger } from './logger';
import type { DrizzleDb, Tx } from './db-types';

export type IdempotencyMode = 'required' | 'optional' | 'none';

export interface AuditSpec<I = any, O = any> {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: (input: I, output: O) => string | undefined;
  /** 從 input 取出可安全寫入 audit 的欄位；沒給則不記錄 payload。 */
  readonly redact?: (input: I) => Record<string, unknown>;
}

/**
 * 從輸入指出這次操作作用在哪一個東西上。Policy 拿得到它，因此可以表達
 * 「不能停用自己」這種與具體資源有關的規則——只有型別的話，policy 只知道
 * 「有人要動一個 user」，不知道是哪一個。
 */
export type ResourceResolver<I> = (input: I) => { readonly id?: string; readonly attributes?: Record<string, unknown> };

export interface CommandDescriptor<I = any, O = any> {
  readonly name: string;
  readonly version: number;
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly permission: string;
  readonly idempotency: IdempotencyMode;
  readonly audit?: AuditSpec<I, O>;
  readonly summary?: string;
  readonly resource?: ResourceResolver<I>;
}

export interface QueryDescriptor<I = any, O = any> {
  readonly name: string;
  readonly version: number;
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly permission: string;
  readonly summary?: string;
}

export interface AuditEntryInput {
  action: string;
  resourceType: string;
  resourceId?: string;
  payload?: Record<string, unknown>;
}

export interface CommandContext {
  readonly actor: Actor;
  readonly tx: Tx;
  readonly logger: Logger;
  readonly correlationId: string;
  readonly now: Date;
  /** 在同一個資料庫交易內寫入 Transactional Outbox。 */
  publish(event: { name: string; payload: unknown }): Promise<void>;
  /** 在同一個交易內寫入 audit log。 */
  audit(entry: AuditEntryInput): Promise<void>;
  /**
   * 在同一個交易內排入背景工作。`replaceExisting` 只適合「同一件尚未發生的
   * 事」被重新排程的情境；它會以 dedupeKey 更新既有工作，而不是另外排一支。
   */
  enqueue(job: { type: string; payload: unknown; dedupeKey?: string; runAt?: Date; replaceExisting?: boolean }): Promise<void>;
}

export interface QueryContext {
  readonly actor: Actor;
  readonly db: DrizzleDb;
  readonly logger: Logger;
  readonly correlationId: string;
  /** 這次查詢的當下時間，與 CommandContext 同樣由 Bus 注入——handler 不自己讀時鐘。 */
  readonly now: Date;
}

export type CommandHandler<I = any, O = any> = (input: I, ctx: CommandContext) => Promise<O>;
export type QueryHandler<I = any, O = any> = (input: I, ctx: QueryContext) => Promise<O>;
export type EventHandlerFn<P = any> = (event: DomainEvent<P>, ctx: EventHandlerContext) => Promise<void>;

export interface EventHandlerContext {
  readonly logger: Logger;
  readonly correlationId: string;
  /** The persisted outbox identity, stable across delivery-job retries and redrive. */
  readonly eventId?: string;
  /** Stable provider/idempotency key for this event/subscriber delivery. */
  readonly idempotencyKey?: string;
  /**
   * 以 system 身分執行一個 Command。只有 Core 模組的訂閱者拿得到——
   * Extension 走 SDK，不該有一支直達 Command Bus 的捷徑。
   *
   * 事件投遞跑在交易外，因此這裡的副作用與發出事件的那筆交易是分開成敗的：
   * 發券失敗不會讓註冊跟著回滾。冪等由呼叫端給的 key 保證。
   */
  readonly executeCommand?: (name: string, input: unknown, idempotencyKey: string) => Promise<unknown>;
}

export function defineCommand<I, O>(d: {
  name: string;
  version?: number;
  input: Schema<I>;
  output: Schema<O>;
  permission: string;
  idempotency?: IdempotencyMode;
  audit?: AuditSpec<I, O>;
  summary?: string;
  resource?: ResourceResolver<I>;
}): CommandDescriptor<I, O> {
  return {
    name: d.name,
    version: d.version ?? 1,
    input: d.input,
    output: d.output,
    permission: d.permission,
    idempotency: d.idempotency ?? 'optional',
    audit: d.audit,
    summary: d.summary,
    resource: d.resource,
  };
}

export function defineQuery<I, O>(d: {
  name: string;
  version?: number;
  input: Schema<I>;
  output: Schema<O>;
  permission: string;
  summary?: string;
}): QueryDescriptor<I, O> {
  return { name: d.name, version: d.version ?? 1, input: d.input, output: d.output, permission: d.permission, summary: d.summary };
}
