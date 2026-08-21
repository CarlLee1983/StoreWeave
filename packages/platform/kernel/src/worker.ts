import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PermanentJobError, type JobRow } from '@storeweave/jobs';
import { toDomainEvent } from '@storeweave/outbox';
import type { Runtime } from './runtime';
import { EVENT_DELIVERY_JOB } from './event-delivery';

export interface WorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  outboxBatchSize?: number;
  staleLockSeconds?: number;
  workerId?: string;
}

export interface WorkerTickResult {
  relayed: number;
  deliveriesEnqueued: number;
  jobsProcessed: number;
  jobsFailed: number;
}

/**
 * 背景工作執行器。只依賴 PostgreSQL，不需要 Redis。
 * 兩個職責：把 Outbox 事件轉成投遞工作，以及執行工作佇列。
 */
export class Worker {
  private readonly workerId: string;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(private readonly runtime: Runtime, private readonly options: WorkerOptions = {}) {
    this.workerId = options.workerId ?? `${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  get id(): string {
    return this.workerId;
  }

  /**
   * 把待轉送的 Outbox 事件轉成每個訂閱者一筆的投遞工作。
   * 事件標記為 relayed 與工作排入是同一個交易 —— 不會漏送，也不會重複排入。
   */
  async relayOutbox(): Promise<{ relayed: number; enqueued: number }> {
    const batchSize = this.options.outboxBatchSize ?? this.runtime.config.worker.outboxBatchSize;
    return this.runtime.database.transaction(async (tx) => {
      const rows = await this.runtime.outbox.claimBatch(tx, batchSize);
      let enqueued = 0;
      for (const row of rows) {
        const event = toDomainEvent(row);
        const subscribers = this.runtime.events.subscribersFor(event.name);
        for (const sub of subscribers) {
          const result = await this.runtime.jobs.enqueue(tx, {
            type: EVENT_DELIVERY_JOB,
            payload: { outboxId: event.id, subscriberId: sub.subscriberId, event },
            dedupeKey: `evt:${event.id}:${sub.subscriberId}`,
            maxAttempts: sub.maxAttempts ?? 8,
          });
          if (!result.deduped) enqueued += 1;
        }
        await this.runtime.outbox.markRelayed(tx, event.id);
      }
      return { relayed: rows.length, enqueued };
    });
  }

  /** 取出並執行一批工作。工作在交易外執行，因此外部 I/O 不會佔住資料庫連線。 */
  async runJobs(): Promise<{ processed: number; failed: number }> {
    const limit = this.options.concurrency ?? this.runtime.config.worker.concurrency;
    const claimed = await this.runtime.database.transaction((tx) =>
      this.runtime.jobs.claim(tx, this.workerId, limit),
    );
    if (claimed.length === 0) return { processed: 0, failed: 0 };

    let processed = 0;
    let failed = 0;
    await Promise.all(
      claimed.map(async (job: JobRow) => {
        const logger = this.runtime.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
        try {
          const handler = this.runtime.jobRegistry.get(job.type);
          await handler(job.payload, { logger, attempt: job.attempts, jobId: job.id });
          await this.runtime.jobs.complete(this.runtime.database.db, job.id);
          processed += 1;
        } catch (err) {
          failed += 1;
          const permanent = err instanceof PermanentJobError;
          const outcome = await this.runtime.jobs.fail(
            this.runtime.database.db, job, (err as Error).message, permanent,
          );
          logger.warn({ error: (err as Error).message, outcome }, 'job failed');
        }
      }),
    );
    return { processed, failed };
  }

  private async heartbeat(): Promise<void> {
    await this.runtime.database.db.execute(sql`
      INSERT INTO platform_worker_heartbeat (worker_id, version, updated_at)
      VALUES (${this.workerId}, ${this.runtime.platformVersion}, now())
      ON CONFLICT (worker_id) DO UPDATE SET updated_at = now(), version = EXCLUDED.version
    `);
  }

  /** 跑一輪：心跳 → 回收卡住的工作 → 轉送 Outbox → 執行工作。測試用它就能得到決定性結果。 */
  async tick(): Promise<WorkerTickResult> {
    await this.heartbeat();
    await this.runtime.jobs.reclaimStale(
      this.runtime.database.db,
      this.options.staleLockSeconds ?? this.runtime.config.worker.staleLockSeconds,
    );
    const relay = await this.relayOutbox();
    const jobs = await this.runJobs();
    return {
      relayed: relay.relayed,
      deliveriesEnqueued: relay.enqueued,
      jobsProcessed: jobs.processed,
      jobsFailed: jobs.failed,
    };
  }

  /** 反覆 tick 直到沒有東西可做（測試與 CLI smoke test 用）。 */
  async drain(maxRounds = 50): Promise<WorkerTickResult> {
    const total: WorkerTickResult = { relayed: 0, deliveriesEnqueued: 0, jobsProcessed: 0, jobsFailed: 0 };
    for (let i = 0; i < maxRounds; i += 1) {
      const result = await this.tick();
      total.relayed += result.relayed;
      total.deliveriesEnqueued += result.deliveriesEnqueued;
      total.jobsProcessed += result.jobsProcessed;
      total.jobsFailed += result.jobsFailed;
      if (result.relayed === 0 && result.jobsProcessed === 0 && result.jobsFailed === 0) break;
    }
    return total;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.options.pollIntervalMs ?? this.runtime.config.worker.pollIntervalMs;
    const loop = async () => {
      if (!this.running) return;
      this.inFlight = this.tick().catch((err) => {
        this.runtime.logger.error({ error: (err as Error).message }, 'worker tick failed');
      });
      await this.inFlight;
      this.inFlight = null;
      if (this.running) this.timer = setTimeout(loop, interval);
    };
    this.runtime.logger.info({ workerId: this.workerId, interval }, 'worker started');
    void loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
    this.runtime.logger.info({ workerId: this.workerId }, 'worker stopped');
  }
}
