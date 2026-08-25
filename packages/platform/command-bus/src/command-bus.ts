import { sql } from 'drizzle-orm';
import {
  PlatformError,
  elapsed,
  logBusCall,
  type Actor,
  type AuditEntryInput,
  type CommandContext,
  type CommandDescriptor,
  type CommandHandler,
  type Logger,
  type Tx,
} from '@storeweave/contracts';
import type { Database } from '@storeweave/db';
import type { AuthorizationService } from '@storeweave/authorization';
import type { AuditWriter } from '@storeweave/audit';
import type { OutboxStore } from '@storeweave/outbox';
import type { JobQueue } from '@storeweave/jobs';
import type { EventBus } from '@storeweave/event-bus';
import { requestHash } from './hash';

export interface CommandRegistration {
  descriptor: CommandDescriptor;
  handler: CommandHandler;
  /** core 模組名稱或 extension id，用於 audit 與 introspection。 */
  owner: string;
}

export interface ExecuteOptions {
  actor: Actor;
  idempotencyKey?: string;
  correlationId?: string;
  /** 由呼叫者宣告的介面來源，只寫進 log/audit，不影響授權。 */
  channel?: 'rest' | 'mcp' | 'cli' | 'admin' | 'internal' | 'worker';
}

export interface CommandBusDeps {
  database: Database;
  authorization: AuthorizationService;
  audit: AuditWriter;
  outbox: OutboxStore;
  jobs: JobQueue;
  events: EventBus;
  logger: Logger;
}

/**
 * 唯一的寫入入口。REST、MCP、Admin、CLI、Worker 全部經過這裡，
 * 因此授權、驗證、Idempotency、Audit、Outbox 只有一份實作。
 */
export class CommandBus {
  private readonly registry = new Map<string, CommandRegistration>();

  constructor(private readonly deps: CommandBusDeps) {}

  register(descriptor: CommandDescriptor, handler: CommandHandler, owner: string): void {
    if (this.registry.has(descriptor.name)) {
      throw PlatformError.conflict(`Command "${descriptor.name}" already registered by "${this.registry.get(descriptor.name)!.owner}"`);
    }
    this.deps.authorization.permissions.assertKnown(descriptor.permission, `command ${descriptor.name}`);
    this.registry.set(descriptor.name, { descriptor, handler, owner });
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  get(name: string): CommandRegistration {
    const reg = this.registry.get(name);
    if (!reg) throw PlatformError.notFound('Command', name);
    return reg;
  }

  list(): CommandRegistration[] {
    return [...this.registry.values()].sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  }

  async execute<O = unknown>(name: string, rawInput: unknown, options: ExecuteOptions): Promise<O> {
    // 單調時鐘：`Date.now()` 會被 NTP 校時往回拉，而這個數字的用途正是分級與比較。
    const startedAt = performance.now();
    // `get()` 刻意留在計時之外：查無此 command 的時候還沒有 logger child 可用，
    // 而那是註冊期的錯誤，不是一次「執行」。
    const { descriptor, handler, owner } = this.get(name);
    const correlationId = options.correlationId ?? cryptoRandom();
    const logger = this.deps.logger.child({ command: name, correlationId, actor: options.actor.id, channel: options.channel ?? 'internal' });

    try {
      const output = await this.run<O>({ descriptor, handler, owner, name, rawInput, options, logger, correlationId, startedAt });
      // 成功那一行寫在交易外：寫在裡面的話，commit 自己失敗時會先吐一行「成功」
      // 再吐一行「失敗」，同一次呼叫兩個 latencyMs，其中一個是假的。
      if (!output.alreadyLogged) {
        logBusCall(logger, 'command', { fields: { owner }, latencyMs: elapsed(startedAt) });
      }
      return output.value;
    } catch (error) {
      logBusCall(logger, 'command', { fields: { owner }, latencyMs: elapsed(startedAt), error });
      throw error;
    }
  }

  /**
   * `execute()` 的本體。抽出來是為了讓計時與失敗那一行只寫一次——
   * 這支從授權一路做到 commit，中間任何一步丟出來都會被上面接住並記下耗時。
   *
   * `alreadyLogged` 是給冪等重放用的：它在交易內就返回了，那一行由它自己寫。
   */
  private async run<O>(call: {
    descriptor: CommandDescriptor;
    handler: CommandHandler;
    owner: string;
    name: string;
    rawInput: unknown;
    options: ExecuteOptions;
    logger: Logger;
    correlationId: string;
    startedAt: number;
  }): Promise<{ value: O; alreadyLogged: boolean }> {
    const { descriptor, handler, owner, name, rawInput, options, logger, correlationId, startedAt } = call;
    this.deps.authorization.assert({
      actor: options.actor,
      permission: descriptor.permission,
      resource: { type: descriptor.name.split('.')[1] ?? 'unknown' },
    });

    const parsed = descriptor.input.safeParse(rawInput);
    if (!parsed.success) {
      throw PlatformError.validation(`Invalid input for "${name}"`, parsed.error.issues);
    }
    const input = parsed.data;

    if (descriptor.idempotency === 'required' && !options.idempotencyKey) {
      throw PlatformError.validation(`Command "${name}" requires an idempotency key`);
    }

    const hash = requestHash(input);

    return this.deps.database.transaction(async (tx) => {
      if (options.idempotencyKey) {
        const replay = await this.claimIdempotency(tx, name, options.idempotencyKey, hash, options.actor.id);
        if (replay.kind === 'replay') {
          // 重放走的是這條捷徑，不會經過下面成功那一行。少了它，客戶端重試風暴時
          // 看到的是流量進來、`command executed` 的計數卻不動——那正是最該量的一種。
          logBusCall(logger, 'command', {
            fields: { owner, replayed: true, idempotencyKey: options.idempotencyKey },
            latencyMs: elapsed(startedAt),
          });
          return { value: replay.response as O, alreadyLogged: true };
        }
      }

      const now = new Date();
      const auditEntries: AuditEntryInput[] = [];
      const ctx: CommandContext = {
        actor: options.actor,
        tx,
        logger,
        correlationId,
        now,
        publish: async (event) => {
          const descriptorForEvent = this.deps.events.getEvent(event.name);
          const payload = descriptorForEvent.payload.safeParse(event.payload);
          if (!payload.success) {
            throw PlatformError.internal(`Event "${event.name}" payload failed validation`, payload.error.issues);
          }
          await this.deps.outbox.append(tx, {
            name: descriptorForEvent.name,
            version: descriptorForEvent.version,
            payload: payload.data,
            actorId: options.actor.id,
            correlationId,
            occurredAt: now,
          });
        },
        audit: async (entry) => {
          auditEntries.push(entry);
          await this.deps.audit.write(tx, { ...entry, actor: options.actor, correlationId });
        },
        enqueue: async (job) => {
          await this.deps.jobs.enqueue(tx, job);
        },
      };

      const result = await handler(input, ctx);
      const outputParsed = descriptor.output.safeParse(result);
      if (!outputParsed.success) {
        throw PlatformError.internal(`Command "${name}" produced invalid output`, outputParsed.error.issues);
      }
      const output = outputParsed.data;

      if (descriptor.audit && auditEntries.length === 0) {
        // resourceId / redact 是宣告式的投影函式。它們丟出不該讓一個已經成功的
        // command 整筆回滾——稽核寫不出漂亮的欄位是缺陷，不是這次交易的失敗。
        let resourceId: string | undefined;
        let payload: Record<string, unknown> | undefined;
        try {
          resourceId = descriptor.audit.resourceId?.(input, output);
          payload = descriptor.audit.redact?.(input);
        } catch (error) {
          logger.warn({ err: error, command: descriptor.name }, 'audit projection failed; writing entry without it');
        }
        await this.deps.audit.write(tx, {
          action: descriptor.audit.action,
          resourceType: descriptor.audit.resourceType,
          resourceId,
          payload,
          actor: options.actor,
          correlationId,
        });
      }

      if (options.idempotencyKey) {
        await tx.execute(sql`
          UPDATE platform_idempotency SET status = 'completed', response = ${JSON.stringify(output ?? null)}::jsonb, completed_at = now()
          WHERE command_name = ${name} AND key = ${options.idempotencyKey}
        `);
      }

      return { value: output as O, alreadyLogged: false };
    });
  }

  /**
   * 在同一個交易內宣告 idempotency key。
   * 併發的第二個請求會卡在唯一索引上直到第一個 commit，然後讀到已完成的結果 —— 不會重複執行。
   */
  private async claimIdempotency(
    tx: Tx,
    commandName: string,
    key: string,
    hash: string,
    actorId: string,
  ): Promise<{ kind: 'claimed' } | { kind: 'replay'; response: unknown }> {
    const inserted = await tx.execute<{ key: string }>(sql`
      INSERT INTO platform_idempotency (command_name, key, request_hash, status, actor_id)
      VALUES (${commandName}, ${key}, ${hash}, 'in_progress', ${actorId})
      ON CONFLICT (command_name, key) DO NOTHING
      RETURNING key
    `);
    if (inserted.rows.length > 0) return { kind: 'claimed' };

    const existing = await tx.execute<{ request_hash: string; status: string; response: unknown; actor_id: string }>(sql`
      SELECT request_hash, status, response, actor_id FROM platform_idempotency
      WHERE command_name = ${commandName} AND key = ${key}
    `);
    const row = existing.rows[0];
    if (!row) throw PlatformError.internal('Idempotency record disappeared');
    if (row.request_hash !== hash) {
      throw new PlatformError('IDEMPOTENCY_MISMATCH', `Idempotency key "${key}" was already used with a different payload`);
    }
    if (row.status !== 'completed') {
      throw new PlatformError('IDEMPOTENCY_IN_PROGRESS', `Request with idempotency key "${key}" is still in progress`);
    }
    // 冪等鍵屬於當初宣告它的人。不比對的話，重放會在 handler 執行之前就回傳快取的結果，
    // 於是 handler 裡的歸屬檢查完全不會執行——猜到別人的鍵就能讀到別人的回應。
    //
    // 回 notFound 而不是 forbidden，理由與訂單查詢相同：後者會變成
    // 「這把鍵存不存在」的 oracle。
    if (row.actor_id !== actorId) {
      throw PlatformError.notFound('Idempotency key', key);
    }
    return { kind: 'replay', response: row.response };
  }
}

function cryptoRandom(): string {
  return require('node:crypto').randomUUID();
}
