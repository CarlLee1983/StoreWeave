import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DrizzleDb, Logger, Tx } from '@storeweave/contracts';
import { PlatformError } from '@storeweave/contracts';

export interface EnqueueInput {
  type: string;
  payload: unknown;
  /**
   * 唯一鍵。相同 dedupeKey 只會排入一次 —— 這是「重複處理不得重複產生外部副作用」的機制。
   */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  /**
   * 同一 dedupeKey 已存在時，以這次 payload 與時間重排它。
   * 這不是一般去重：只用在「同一件未來工作」改了截止時間的情況。
   */
  replaceExisting?: boolean;
}

export interface DeadJobRow {
  [key: string]: unknown;
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  last_error: string | null;
  updated_at: Date;
}

export interface JobRow {
  [key: string]: unknown;
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
}

export interface JobContext {
  readonly logger: Logger;
  readonly attempt: number;
  readonly jobId: string;
}

export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<void>;

/** 標記為不可重試的錯誤 —— 直接進 dead，不再消耗重試次數。 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export class JobQueue {
  /** 在交易內排入工作。dedupeKey 衝突時預設視為已排入（no-op）。 */
  async enqueue(tx: Tx, input: EnqueueInput): Promise<{ id: string; deduped: boolean }> {
    const id = randomUUID();
    if (input.replaceExisting && input.dedupeKey) {
      const res = await tx.execute<{ id: string }>(sql`
        INSERT INTO platform_jobs (id, type, payload, dedupe_key, run_at, max_attempts)
        VALUES (${id}, ${input.type}, ${JSON.stringify(input.payload ?? {})}::jsonb,
                ${input.dedupeKey}, ${(input.runAt ?? new Date()).toISOString()}, ${input.maxAttempts ?? 5})
        ON CONFLICT (dedupe_key) DO UPDATE
        SET type = EXCLUDED.type,
            payload = EXCLUDED.payload,
            run_at = EXCLUDED.run_at,
            max_attempts = EXCLUDED.max_attempts,
            status = 'pending',
            attempts = 0,
            last_error = NULL,
            locked_at = NULL,
            locked_by = NULL,
            completed_at = NULL,
            updated_at = now()
        RETURNING id
      `);
      return { id: res.rows[0].id, deduped: false };
    }
    const res = await tx.execute<{ id: string }>(sql`
      INSERT INTO platform_jobs (id, type, payload, dedupe_key, run_at, max_attempts)
      VALUES (${id}, ${input.type}, ${JSON.stringify(input.payload ?? {})}::jsonb,
              ${input.dedupeKey ?? null}, ${(input.runAt ?? new Date()).toISOString()}, ${input.maxAttempts ?? 5})
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `);
    if (res.rows.length === 0) return { id, deduped: true };
    return { id: res.rows[0].id, deduped: false };
  }

  /** 鎖定一批待處理工作。必須在交易中呼叫。 */
  async claim(tx: Tx, workerId: string, limit: number, types?: readonly string[]): Promise<JobRow[]> {
    const typeFilter = types && types.length > 0 ? sql`AND type = ANY(${sql.raw(`ARRAY[${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')}]`)})` : sql``;
    const res = await tx.execute<JobRow>(sql`
      UPDATE platform_jobs SET status = 'running', locked_at = now(), locked_by = ${workerId},
             attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM platform_jobs
        WHERE status = 'pending' AND run_at <= now() ${typeFilter}
        ORDER BY run_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, payload, attempts, max_attempts, dedupe_key
    `);
    return res.rows;
  }

  /**
   * `workerId` guards a job that was rescheduled while an older worker still
   * held it: that older worker must not complete the newly queued occurrence.
   */
  async complete(db: DrizzleDb, id: string, workerId: string): Promise<void> {
    await db.execute(sql`
      UPDATE platform_jobs SET status = 'completed', completed_at = now(), updated_at = now(), last_error = NULL
      WHERE id = ${id} AND status = 'running' AND locked_by = ${workerId}
    `);
  }

  async fail(db: DrizzleDb, job: JobRow, error: string, permanent = false, workerId?: string): Promise<'retry' | 'dead'> {
    const exhausted = permanent || job.attempts >= job.max_attempts;
    const delaySeconds = Math.min(600, 2 ** Math.min(job.attempts, 9));
    await db.execute(sql`
      UPDATE platform_jobs
      SET status = ${exhausted ? 'dead' : 'pending'},
          last_error = ${error.slice(0, 2000)},
          run_at = now() + (${delaySeconds} * interval '1 second'),
          locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = ${job.id}
        AND status = 'running'
        ${workerId ? sql`AND locked_by = ${workerId}` : sql``}
    `);
    return exhausted ? 'dead' : 'retry';
  }

  /** 人工重送：把 dead / completed 的工作重新排入。 */
  async requeue(db: DrizzleDb, id: string): Promise<void> {
    const res = await db.execute<{ id: string }>(sql`
      UPDATE platform_jobs
      SET status = 'pending', run_at = now(), attempts = 0, last_error = NULL,
          locked_at = NULL, locked_by = NULL, completed_at = NULL, updated_at = now()
      WHERE id = ${id}
      RETURNING id
    `);
    if (res.rows.length === 0) throw PlatformError.notFound('Job', id);
  }

  /**
   * 死信專用的重送：只放行 status = 'dead' 的工作。
   * 與 requeue 分開是刻意的 —— 對 completed 的工作重送會再產生一次外部副作用。
   */
  async retryDead(db: DrizzleDb, id: string): Promise<void> {
    const res = await db.execute<{ id: string }>(sql`
      UPDATE platform_jobs
      SET status = 'pending', run_at = now(), attempts = 0, last_error = NULL,
          locked_at = NULL, locked_by = NULL, completed_at = NULL, updated_at = now()
      WHERE id = ${id} AND status = 'dead'
      RETURNING id
    `);
    if (res.rows.length === 0) throw PlatformError.notFound('Dead job', id);
  }

  /** 釋放被 crash 的 worker 卡住的工作。 */
  async reclaimStale(db: DrizzleDb, olderThanSeconds: number): Promise<number> {
    const res = await db.execute<{ id: string }>(sql`
      UPDATE platform_jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE status = 'running' AND locked_at < now() - (${olderThanSeconds} * interval '1 second')
      RETURNING id
    `);
    return res.rows.length;
  }

  async stats(db: DrizzleDb): Promise<Record<string, number>> {
    const res = await db.execute<{ status: string; count: string }>(
      sql`SELECT status, count(*)::text AS count FROM platform_jobs GROUP BY status`,
    );
    const out: Record<string, number> = { pending: 0, running: 0, completed: 0, dead: 0 };
    for (const r of res.rows) out[r.status] = Number(r.count);
    return out;
  }

  /** 列出耗盡重試而進入死信佇列的工作，最近失敗的排在前面。 */
  async listDead(db: DrizzleDb, options: { limit: number; offset: number }): Promise<{ items: DeadJobRow[]; total: number }> {
    const res = await db.execute<DeadJobRow>(sql`
      SELECT id, type, payload, attempts, max_attempts, dedupe_key, last_error, updated_at
      FROM platform_jobs WHERE status = 'dead'
      ORDER BY updated_at DESC
      LIMIT ${options.limit} OFFSET ${options.offset}
    `);
    const count = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM platform_jobs WHERE status = 'dead'`,
    );
    return { items: res.rows, total: Number(count.rows[0]?.count ?? 0) };
  }

  async findByDedupeKey(db: DrizzleDb, key: string): Promise<(JobRow & { status: string; last_error: string | null }) | null> {
    const res = await db.execute<JobRow & { status: string; last_error: string | null }>(sql`
      SELECT id, type, payload, attempts, max_attempts, dedupe_key, status, last_error
      FROM platform_jobs WHERE dedupe_key = ${key}
    `);
    return res.rows[0] ?? null;
  }
}
