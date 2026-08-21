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

export interface CommandDescriptor<I = any, O = any> {
  readonly name: string;
  readonly version: number;
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly permission: string;
  readonly idempotency: IdempotencyMode;
  readonly audit?: AuditSpec<I, O>;
  readonly summary?: string;
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
  /** 在同一個交易內排入背景工作。 */
  enqueue(job: { type: string; payload: unknown; dedupeKey?: string; runAt?: Date }): Promise<void>;
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
