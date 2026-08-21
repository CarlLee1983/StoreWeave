import { PlatformError, type Logger } from '@storeweave/contracts';
import type { JobQueue } from '@storeweave/jobs';
import type { Database } from '@storeweave/db';

/**
 * 週期性工作。
 *
 * 平台沒有排程器，工作佇列只認得「在這個時間之後執行一次」。要讓一件事每隔固定時間
 * 再跑一次，直覺的做法是讓工作在結束時自己排下一次；但那條鏈只要斷一次就永遠不會再接上
 * —— 工作耗盡重試進了死信，之後就再也沒有人排下一次，而且沒有任何地方會叫。
 *
 * 這裡改成不依賴鏈：時間被切成固定長度的「切片」，第 N 個切片對應唯一一個去重鍵，
 * Worker 每一輪只做一件事——確保「當下這個切片」已經排進佇列。排過就是 no-op（去重鍵擋下），
 * 沒排過就補上。工作失敗、重試、進死信都不影響下一個切片，因為根本沒有鏈。
 *
 * 代價是停機期間跨過的切片不會被追補：醒來時只排當下這一個。需要追補的工作
 * （例如補發昨天的生日禮券）要自己在 handler 裡處理，那是領域問題不是排程問題。
 */
export interface RecurringJob {
  /** 已註冊的工作型別 */
  readonly type: string;
  /** 週期長度（毫秒） */
  readonly everyMs: number;
}

/** 這個時刻落在第幾個切片。 */
export function bucketFor(at: Date, everyMs: number): number {
  return Math.floor(at.getTime() / everyMs);
}

/** 切片的起點，也就是那一次的預定執行時間。 */
export function occurrenceRunAt(bucket: number, everyMs: number): Date {
  return new Date(bucket * everyMs);
}

/** 一個切片對應唯一一個去重鍵；換切片就換鍵。 */
export function occurrenceKeyFor(type: string, bucket: number): string {
  return `recurring:${type}:${bucket}`;
}

export interface RecurringSchedulerDeps {
  readonly jobs: Pick<JobQueue, 'enqueue'>;
  readonly database: Pick<Database, 'transaction'>;
  readonly logger: Logger;
}

export class RecurringScheduler {
  private readonly registered = new Map<string, RecurringJob>();
  /** 這個行程已經確認過的切片，避免每一輪 tick 都打一次資料庫。 */
  private readonly ensured = new Map<string, number>();

  constructor(private readonly deps: RecurringSchedulerDeps) {}

  register(job: RecurringJob): void {
    if (this.registered.has(job.type)) {
      throw PlatformError.conflict(`Recurring job "${job.type}" already registered`);
    }
    if (!Number.isFinite(job.everyMs) || job.everyMs <= 0) {
      throw PlatformError.validation(`Recurring job "${job.type}" needs a positive everyMs`);
    }
    this.registered.set(job.type, job);
  }

  types(): string[] {
    return [...this.registered.keys()].sort();
  }

  /**
   * 確保每個週期性工作「當下這個切片」都已經排入。
   * 由 Worker 每一輪呼叫；同一個切片內只會真的碰一次資料庫。
   */
  async ensureScheduled(now: Date = new Date()): Promise<{ enqueued: number }> {
    if (this.registered.size === 0) return { enqueued: 0 };

    let enqueued = 0;
    for (const job of this.registered.values()) {
      const bucket = bucketFor(now, job.everyMs);
      if (this.ensured.get(job.type) === bucket) continue;

      const result = await this.deps.database.transaction((tx) =>
        this.deps.jobs.enqueue(tx, {
          type: job.type,
          payload: { bucket, scheduledFor: occurrenceRunAt(bucket, job.everyMs).toISOString() },
          dedupeKey: occurrenceKeyFor(job.type, bucket),
          runAt: occurrenceRunAt(bucket, job.everyMs),
        }),
      );

      this.ensured.set(job.type, bucket);
      if (!result.deduped) {
        enqueued += 1;
        this.deps.logger.debug({ jobType: job.type, bucket }, 'recurring occurrence scheduled');
      }
    }
    return { enqueued };
  }
}
