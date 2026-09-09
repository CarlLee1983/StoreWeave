import { noopLogger, type Logger } from '@storeweave/contracts';
import { createHttpClient } from '@storeweave/http-client';
import type { ExtensionContext } from './context';
import type { ExtensionStore, ExtensionStoreEntry } from './store';
import type { AnyProvider, ProviderKind } from './providers';
import type { MailDiagnostic } from '@storeweave/mail';
import type { ExtensionMailSendRequest } from './context';

/** 記憶體版 ExtensionStore，供 contract test 與單元測試使用。 */
export class InMemoryExtensionStore implements ExtensionStore {
  private readonly data = new Map<string, { value: unknown; updatedAt: Date }>();
  private readonly mutationLocks = new Map<string, Promise<void>>();

  async get<T>(key: string): Promise<T | null> {
    const hit = this.data.get(key);
    return hit ? (structuredClone(hit.value) as T) : null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, { value: structuredClone(value), updatedAt: new Date() });
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list<T>(prefix = '', limit = 100, afterKey?: string): Promise<ExtensionStoreEntry<T>[]> {
    return [...this.data.entries()]
      .filter(([k]) => k.startsWith(prefix) && k > (afterKey ?? ''))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([key, v]) => ({ key, value: structuredClone(v.value) as T, updatedAt: v.updatedAt }));
  }
  async mutate<T>(key: string, fn: (current: T | null) => T): Promise<T> {
    const previous = this.mutationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.mutationLocks.set(key, lock);
    await previous;
    try {
      const next = fn(await this.get<T>(key));
      await this.set(key, next);
      return next;
    } finally {
      release();
      if (this.mutationLocks.get(key) === lock) this.mutationLocks.delete(key);
    }
  }
}

export interface TestContextOptions<TConfig> {
  extensionId: string;
  extensionVersion?: string;
  platformVersion?: string;
  config: TConfig;
  logger?: Logger;
  commands?: Record<string, (input: unknown, options?: { idempotencyKey?: string }) => Promise<unknown>>;
  queries?: Record<string, (input: unknown) => Promise<unknown>>;
  providers?: Partial<Record<ProviderKind, AnyProvider>>;
  secrets?: Record<string, string>;
  now?: () => Date;
  /** 測試用的 fetch 替身。未給時對外 HTTP 一律失敗，測試不會打到真實端點。 */
  fetch?: typeof fetch;
  mail?: { send(input: ExtensionMailSendRequest): Promise<MailDiagnostic>; enqueue(input: ExtensionMailSendRequest): Promise<MailDiagnostic> };
}

export interface TestExtensionContext<TConfig> extends ExtensionContext<TConfig> {
  readonly store: InMemoryExtensionStore;
  readonly calls: {
    commands: { name: string; input: unknown; idempotencyKey?: string }[];
    queries: { name: string; input: unknown }[];
    jobs: { type: string; payload: unknown; dedupeKey?: string }[];
  };
  /** 直接執行剛剛排入的工作，用來在測試中走完一整條流程。 */
  drainJobs(handlers: Record<string, (payload: unknown, ctx: any) => Promise<void>>): Promise<void>;
}

/** 建立不需要資料庫的 Extension 執行環境，用於 Extension Contract Test。 */
export function createTestExtensionContext<TConfig>(
  options: TestContextOptions<TConfig>,
): TestExtensionContext<TConfig> {
  const store = new InMemoryExtensionStore();
  const calls = { commands: [] as any[], queries: [] as any[], jobs: [] as any[] };
  const queue: { id: string; type: string; payload: unknown; dedupeKey?: string; attempts: number }[] = [];
  const seenDedupe = new Set<string>();
  let counter = 0;

  const ctx: TestExtensionContext<TConfig> = {
    extensionId: options.extensionId,
    extensionVersion: options.extensionVersion ?? '0.0.0',
    platformVersion: options.platformVersion ?? '1.0.0',
    config: options.config,
    logger: options.logger ?? noopLogger,
    // 測試替身必須 fail-closed：忘了給替身時要明確失敗，而不是靜靜地打真實網路
    // ——那會讓 CI 無網路時變成隨機失敗，也可能真的送出 provider 請求。
    http: (httpOptions) => createHttpClient({
      ...httpOptions,
      fetch: options.fetch ?? (() => {
        throw new Error('This test context has no fetch stub. Pass `fetch` to createTestExtensionContext.');
      }),
    }),
    store,
    calls,
    commands: {
      async execute(name, input, opts) {
        calls.commands.push({ name, input, idempotencyKey: opts?.idempotencyKey });
        const impl = options.commands?.[name];
        if (!impl) throw new Error(`Test context has no stub for command "${name}"`);
        return (await impl(input, opts)) as any;
      },
    },
    queries: {
      async execute(name, input) {
        calls.queries.push({ name, input });
        const impl = options.queries?.[name];
        if (!impl) throw new Error(`Test context has no stub for query "${name}"`);
        return (await impl(input)) as any;
      },
    },
    jobs: {
      async enqueue(input) {
        calls.jobs.push({ type: input.type, payload: input.payload, dedupeKey: input.dedupeKey });
        if (input.dedupeKey && seenDedupe.has(input.dedupeKey)) return { id: 'deduped', deduped: true };
        if (input.dedupeKey) seenDedupe.add(input.dedupeKey);
        const id = `job-${++counter}`;
        queue.push({ id, type: input.type, payload: input.payload, dedupeKey: input.dedupeKey, attempts: 0 });
        return { id, deduped: false };
      },
      async requeue(jobId) {
        const existing = queue.find((j) => j.id === jobId);
        if (!existing) throw new Error(`Job ${jobId} not found`);
        existing.attempts = 0;
      },
      async retryDead(jobId) {
        const existing = queue.find((j) => j.id === jobId);
        if (!existing) throw new Error(`Dead job ${jobId} not found`);
        // The in-memory contract double has no worker-status lifecycle. Its
        // production counterpart is status-guarded by JobQueue.retryDead().
        existing.attempts = 0;
      },
    },
    mail: options.mail ?? {
      async send() { throw new Error('This test context has no mail stub. Pass `mail` to createTestExtensionContext.'); },
      async enqueue() { throw new Error('This test context has no mail stub. Pass `mail` to createTestExtensionContext.'); },
    },
    getProvider<T extends AnyProvider>(kind: ProviderKind, _id?: string): T {
      const p = options.providers?.[kind];
      if (!p) throw new Error(`Test context has no ${kind} provider`);
      return p as T;
    },
    secret(name) {
      return options.secrets?.[name];
    },
    now: options.now ?? (() => new Date()),
    async drainJobs(handlers) {
      while (queue.length > 0) {
        const job = queue.shift()!;
        const handler = handlers[job.type];
        if (!handler) throw new Error(`No handler for job type "${job.type}"`);
        await handler(job.payload, { ...ctx, attempt: job.attempts + 1, jobId: job.id });
      }
    },
  };
  return ctx;
}
