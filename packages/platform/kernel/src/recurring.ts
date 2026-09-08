import { sql } from 'drizzle-orm';
import { PlatformError, type Logger, type Tx } from '@storeweave/contracts';
import type { JobQueue } from '@storeweave/jobs';
import type { Database } from '@storeweave/db';
import {
  MAX_OCCURRENCES_PER_SCAN,
  coldStartWatermark,
  nextOccurrence,
  occurrencesBetween,
  parseScheduleSpec,
  scheduleOccurrenceKey,
  scheduleOccurrencePayload,
  type ScheduleDeclaration,
  type ScheduleSpec,
} from './schedule-spec';

export * from './schedule-spec';

/**
 * 週期性工作的排程器。
 *
 * 佇列只認得「在這個時間之後執行一次」，所以排程器唯一的動作是**算出該跑的那幾次並 enqueue**；
 * 執行仍然由同一個 worker 從佇列取出，走 B04 的 occurrence fencing 與重試路徑（ADR 0038）。
 * 這裡不持有任何 timer，行程重啟不會遺失狀態。
 *
 * ADR 0016 用 epoch 對齊的切片避免「自我續排的鏈斷掉就再也接不回來」。那個理由仍然成立，
 * 而且被保留：每一次 occurrence 的身分就是它的預定時刻，彼此之間沒有鏈。
 * 相對於 0016 的兩個改變：
 *
 * - **狀態進了資料庫。** `platform_job_schedules` 記住「已經排到哪一次」（watermark）。
 *   0016 靠行程內快取避免每輪打資料庫，代價是暫停／恢復要等到下一個切片才會被看見，
 *   而且停機期間跨過的切片完全無法追補。現在每輪每個排程做一次主鍵查詢，
 *   換到有界追補與立即生效的 pause／resume；排程數量是個位數，這個成本是划算的。
 * - **多 worker 由列鎖序列化。** upsert 當下就鎖住那一列，去重鍵仍然是最後一道防線。
 */

export interface ScheduleStatus {
  readonly type: string;
  readonly kind: 'interval' | 'cron';
  readonly expression: string;
  readonly timezone: string | null;
  readonly catchUp: number;
  readonly overlap: 'queue' | 'skip';
  readonly paused: boolean;
  readonly pausedAt: Date | null;
  readonly lastOccurrenceAt: Date | null;
  readonly lastEnqueuedAt: Date | null;
  readonly skippedCatchup: number;
  readonly skippedPaused: number;
  readonly skippedOverlap: number;
  readonly consecutiveOverlapSkips: number;
  /** 暫停中一律是 null：顯示一個不會發生的時間比不顯示更糟。 */
  readonly nextOccurrenceAt: Date | null;
}

export interface EnsureScheduledResult {
  /** 這一輪真的排進佇列的 occurrence 數。 */
  readonly enqueued: number;
  /** 因追補上限、暫停或 overlap 策略而**不會執行**的 occurrence 數。 */
  readonly skipped: number;
  /** 另一個 worker 已經排過同一次。正常的多 worker 行為，不是跳過。 */
  readonly deduped: number;
}

const EMPTY: EnsureScheduledResult = { enqueued: 0, skipped: 0, deduped: 0 };

/** 連續這麼多輪被 overlap 擋下就示警：多半代表上一次卡住了，而不是它真的很忙。 */
const OVERLAP_SKIP_WARN_THRESHOLD = 3;

interface SkipCounts {
  readonly catchup: number;
  readonly paused: number;
  readonly overlap: number;
}

interface ScheduleRow {
  [key: string]: unknown;
  type: string;
  fingerprint: string;
  paused: boolean;
  paused_at: string | Date | null;
  last_occurrence_at: string | Date | null;
  last_enqueued_at: string | Date | null;
  skipped_catchup: string | number;
  skipped_paused: string | number;
  skipped_overlap: string | number;
  consecutive_overlap_skips: number;
}

const SCHEDULE_COLUMNS = sql`type, fingerprint, paused, paused_at, last_occurrence_at, last_enqueued_at,
  skipped_catchup, skipped_paused, skipped_overlap, consecutive_overlap_skips`;

/** 原生 `execute` 不保證把 timestamptz 轉成 Date，明確轉一次比在每個呼叫點猜安全。 */
function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export interface RecurringSchedulerDeps {
  readonly jobs: Pick<JobQueue, 'enqueue'>;
  readonly database: Pick<Database, 'boundedTransaction'>;
  readonly logger: Logger;
  /** 單一排程交易的整體上限；未指定時沿用 worker 的資料庫逾時預設。 */
  readonly timeoutMs?: number;
  /** Worker 的輪詢間隔。用來在註冊時檢查宣告的頻率有沒有高過排程器實際被叫到的頻率。 */
  readonly pollIntervalMs?: number;
}

const DEFAULT_SCHEDULE_TIMEOUT_MS = 5_000;

export class RecurringScheduler {
  private readonly registered = new Map<string, ScheduleSpec>();

  constructor(private readonly deps: RecurringSchedulerDeps) {}

  /** 註冊時就解析並驗證宣告：非法 cron 或時區讓啟動失敗，而不是半夜安靜地漏跑。 */
  register(type: string, declaration: ScheduleDeclaration): void {
    if (this.registered.has(type)) {
      throw PlatformError.conflict(`Recurring job "${type}" already registered`);
    }
    const spec = parseScheduleSpec(type, declaration);
    this.warnIfFasterThanPolling(type, spec);
    this.registered.set(type, spec);
  }

  /**
   * 宣告的頻率高過 worker 輪詢的頻率時，每一輪會有多個 occurrence 同時到期，
   * 而 `catchUp`（預設 1）只會排最新那一個，其餘全部進 skipped。
   * 這不是錯誤，但作者八成不是這個意思，所以要說出來而不是安靜地丟掉。
   */
  private warnIfFasterThanPolling(type: string, spec: ScheduleSpec): void {
    const poll = this.deps.pollIntervalMs;
    if (!poll) return;
    const now = new Date();
    const first = nextOccurrence(spec, now);
    const second = first ? nextOccurrence(spec, first) : undefined;
    if (!first || !second) return;
    const spacing = second.getTime() - first.getTime();
    if (spacing >= poll * spec.catchUp) return;
    this.deps.logger.warn(
      { jobType: type, spacingMs: spacing, pollIntervalMs: poll, catchUp: spec.catchUp },
      'schedule fires faster than the worker polls; occurrences beyond catchUp will be skipped',
    );
  }

  types(): string[] {
    return [...this.registered.keys()].sort();
  }

  specFor(type: string): ScheduleSpec | undefined {
    return this.registered.get(type);
  }

  /**
   * 確保每個排程「該跑而還沒排」的 occurrence 都已經進佇列。
   * 由 Worker 每一輪呼叫，時間由呼叫端注入，因此測試不需要等真實時鐘。
   */
  async ensureScheduled(now: Date = new Date()): Promise<EnsureScheduledResult> {
    if (this.registered.size === 0) return EMPTY;

    let enqueued = 0;
    let skipped = 0;
    let deduped = 0;
    for (const [type, spec] of this.registered) {
      try {
        const result = await this.deps.database.boundedTransaction(
          this.deps.timeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS,
          `ensure schedule ${type}`,
          (tx) => this.ensureOne(tx, type, spec, now),
        );
        enqueued += result.enqueued;
        skipped += result.skipped;
        deduped += result.deduped;
      } catch (error) {
        // 排程是「確保」而不是「執行」：這一輪沒排到，下一輪會再算一次同一個 occurrence，
        // 去重鍵讓重試不會變成重複。一個排程的鎖等待或連線抖動不該讓整個 worker 停擺，
        // 也不該連帶擋掉同一輪的 relayOutbox 與 runJobs。
        this.deps.logger.error(
          { jobType: type, error: (error as Error).message },
          'schedule tick failed; will retry on the next tick',
        );
      }
    }
    return { enqueued, skipped, deduped };
  }

  /** 一個排程一個有界交易；呼叫端逐一 catch，所以某個排程的錯誤不會讓其他排程整輪停擺。 */
  private async ensureOne(tx: Tx, type: string, spec: ScheduleSpec, now: Date): Promise<EnsureScheduledResult> {
    const row = await this.lockRow(tx, type, spec, now);
    const watermark = toDate(row.last_occurrence_at);
    if (!watermark) return EMPTY;

    const all = occurrencesBetween(spec, watermark, now, MAX_OCCURRENCES_PER_SCAN);
    if (all.length === 0) return EMPTY;

    const newest = all[all.length - 1];
    // 追補有上限：停機太久時補最近的那幾次，不是最舊的那幾次。
    const due = all.slice(Math.max(0, all.length - spec.catchUp));
    const catchup = all.length - due.length;

    if (row.paused) {
      // 暫停期間的 occurrence 是「跳過」不是「延後」：恢復時不該一次湧出整段積壓。
      await this.advance(tx, type, newest, { catchup, paused: due.length, overlap: 0 }, false, 0);
      return { enqueued: 0, skipped: catchup + due.length, deduped: 0 };
    }

    if (spec.overlap === 'skip' && (await this.hasActiveJob(tx, type, now))) {
      const consecutive = row.consecutive_overlap_skips + 1;
      await this.advance(tx, type, newest, { catchup, paused: 0, overlap: due.length }, false, consecutive);
      // 連續被擋下多半是上一次卡住（等 lease reclaim、被 concurrency policy 壓住、
      // 或從死信 redrive 回來），不是它真的忙。這種事安靜地跳過幾天是不能接受的。
      const log = consecutive >= OVERLAP_SKIP_WARN_THRESHOLD ? this.deps.logger.warn : this.deps.logger.debug;
      // log 的數字與回傳值、與 skipped_* 欄位必須是同一個，否則排查時對不起來。
      log.call(this.deps.logger, { jobType: type, skipped: catchup + due.length, consecutive },
        'schedule occurrence skipped by overlap policy');
      return { enqueued: 0, skipped: catchup + due.length, deduped: 0 };
    }

    let enqueued = 0;
    let deduped = 0;
    for (const occurrenceAt of due) {
      const result = await this.deps.jobs.enqueue(tx, {
        type,
        payload: scheduleOccurrencePayload(spec, occurrenceAt),
        dedupeKey: scheduleOccurrenceKey(type, spec, occurrenceAt),
        runAt: occurrenceAt,
      });
      // 去重代表另一個 worker 已經排過同一次：那一次**會**執行，所以不是跳過。
      if (result.deduped) deduped += 1;
      else enqueued += 1;
    }

    await this.advance(tx, type, newest, { catchup, paused: 0, overlap: 0 }, enqueued > 0, 0);
    if (enqueued > 0) {
      this.deps.logger.debug({ jobType: type, enqueued, upTo: newest.toISOString() }, 'schedule occurrences enqueued');
    }
    return { enqueued, skipped: catchup, deduped };
  }

  /**
   * 取得排程狀態列的寫鎖。
   *
   * 穩定狀態下這是一次 `SELECT … FOR UPDATE`，沒有寫入——排程器每一輪都會跑，
   * 若每輪都 UPDATE 一次 `updated_at`，長期下來只是在製造 WAL 與 bloat。
   * 只有第一次見到這個排程，或宣告真的變了，才寫。
   *
   * 宣告變更時把 watermark 重設到「當下這一次的前一次」：新的時間表不該重放舊的，
   * 但也不該讓當下這一次消失。
   */
  private async lockRow(tx: Tx, type: string, spec: ScheduleSpec, now: Date): Promise<ScheduleRow> {
    // anchor 只有「查無此列」「watermark 是 NULL」「宣告變了」三條分支用得到，
    // 而穩定狀態下三條都不會走。它對 cron 是一次 previousRuns，惰性求值才不會每輪白算。
    let cached: { anchor: Date | null } | undefined;
    const anchorOf = () => (cached ??= { anchor: coldStartWatermark(spec, now) ?? null }).anchor;
    const anchorSql = () => {
      const anchor = anchorOf();
      return anchor ? sql`CAST(${anchor.toISOString()} AS timestamptz)` : sql`NULL`;
    };

    let row = await this.selectForUpdate(tx, type);
    if (!row) {
      await tx.execute(sql`
        INSERT INTO platform_job_schedules (type, fingerprint, last_occurrence_at)
        VALUES (${type}, ${spec.fingerprint}, ${anchorSql()})
        ON CONFLICT (type) DO NOTHING
      `);
      // 併發時另一個 worker 可能先插入；重讀一次才會拿到那一列的鎖。
      row = await this.selectForUpdate(tx, type);
      if (!row) {
        // 目前沒有刪除排程列的路徑，所以走到這裡代表有人加了一條而沒想到這裡。
        // 裸的 undefined 解參考在 log 裡看不出是哪個 type、哪個階段。
        throw PlatformError.conflict(`Schedule row for "${type}" disappeared during insert`);
      }
    }

    // watermark 是 NULL 就沒有起算點，`ensureOne` 會每一輪提早返回——這個排程等於死了，
    // 而且安靜。就地補上 anchor 讓它能恢復；補不出來（連一次過往 occurrence 都算不到）
    // 就要留下痕跡，不能讓它變成沒有人會發現的沉默。
    if (row.last_occurrence_at === null) {
      if (!anchorOf()) {
        this.deps.logger.warn(
          { jobType: type },
          'schedule has no computable previous occurrence; it will not enqueue until one exists',
        );
        return row;
      }
      const res = await tx.execute<ScheduleRow>(sql`
        UPDATE platform_job_schedules
        SET last_occurrence_at = ${anchorSql()}, fingerprint = ${spec.fingerprint}, updated_at = now()
        WHERE type = ${type}
        RETURNING ${SCHEDULE_COLUMNS}
      `);
      return res.rows[0];
    }

    if (row.fingerprint !== spec.fingerprint) {
      const res = await tx.execute<ScheduleRow>(sql`
        UPDATE platform_job_schedules
        SET fingerprint = ${spec.fingerprint}, last_occurrence_at = ${anchorSql()}, updated_at = now()
        WHERE type = ${type}
        RETURNING ${SCHEDULE_COLUMNS}
      `);
      return res.rows[0];
    }
    return row;
  }

  private async selectForUpdate(tx: Tx, type: string): Promise<ScheduleRow | undefined> {
    const res = await tx.execute<ScheduleRow>(sql`
      SELECT ${SCHEDULE_COLUMNS} FROM platform_job_schedules WHERE type = ${type} FOR UPDATE
    `);
    return res.rows[0];
  }

  private async advance(
    tx: Tx, type: string, upTo: Date, skips: SkipCounts, enqueued: boolean, consecutiveOverlap: number,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE platform_job_schedules
      SET last_occurrence_at = CAST(${upTo.toISOString()} AS timestamptz),
          last_enqueued_at = ${enqueued ? sql`now()` : sql`last_enqueued_at`},
          skipped_catchup = skipped_catchup + ${skips.catchup},
          skipped_paused = skipped_paused + ${skips.paused},
          skipped_overlap = skipped_overlap + ${skips.overlap},
          consecutive_overlap_skips = ${consecutiveOverlap},
          updated_at = now()
      WHERE type = ${type}
    `);
  }

  /**
   * overlap='skip' 的判準：同型別還有沒有**已經到期而沒跑完**的工作。
   * 排在未來的那一筆不算重疊——否則剛排好下一次就會把自己擋住。
   */
  private async hasActiveJob(tx: Tx, type: string, now: Date): Promise<boolean> {
    const res = await tx.execute<{ one: number }>(sql`
      SELECT 1 AS one FROM platform_jobs
      WHERE type = ${type} AND status IN ('pending', 'running')
        AND run_at <= CAST(${now.toISOString()} AS timestamptz)
      LIMIT 1
    `);
    return res.rows.length > 0;
  }

  /** 維運讀取用：宣告與持久化狀態合起來的檢視。 */
  async list(db: Pick<Database, 'db'>['db'], now: Date = new Date()): Promise<ScheduleStatus[]> {
    const res = await db.execute<ScheduleRow>(sql`
      SELECT ${SCHEDULE_COLUMNS} FROM platform_job_schedules
    `);
    const rows = new Map(res.rows.map((row) => [row.type, row]));
    return this.types().map((type) => {
      const spec = this.registered.get(type)!;
      const row = rows.get(type);
      return {
        type,
        kind: spec.kind,
        expression: spec.kind === 'cron' ? spec.cron : String(spec.everyMs),
        timezone: spec.kind === 'cron' ? spec.timezone : null,
        catchUp: spec.catchUp,
        overlap: spec.overlap,
        paused: row?.paused ?? false,
        pausedAt: toDate(row?.paused_at),
        lastOccurrenceAt: toDate(row?.last_occurrence_at),
        lastEnqueuedAt: toDate(row?.last_enqueued_at),
        skippedCatchup: Number(row?.skipped_catchup ?? 0),
        skippedPaused: Number(row?.skipped_paused ?? 0),
        skippedOverlap: Number(row?.skipped_overlap ?? 0),
        consecutiveOverlapSkips: row?.consecutive_overlap_skips ?? 0,
        // 暫停中的排程不該顯示一個永遠不會發生的「下一次」——那會讓值班的人往錯的方向查。
        nextOccurrenceAt: row?.paused ? null : nextOccurrence(spec, now) ?? null,
      };
    });
  }

  /** 暫停／恢復。未註冊的型別直接拒絕，避免在狀態表裡留下沒有人會讀的列。 */
  async setPaused(tx: Tx, type: string, paused: boolean, now: Date = new Date()): Promise<void> {
    const spec = this.registered.get(type);
    if (!spec) throw PlatformError.notFound(`Schedule "${type}" is not registered in this release`);
    const anchor = coldStartWatermark(spec, now) ?? null;
    await tx.execute(sql`
      INSERT INTO platform_job_schedules (type, fingerprint, paused, paused_at, last_occurrence_at)
      VALUES (${type}, ${spec.fingerprint}, ${paused}, ${paused ? sql`now()` : sql`NULL`},
              ${anchor ? sql`CAST(${anchor.toISOString()} AS timestamptz)` : sql`NULL`})
      ON CONFLICT (type) DO UPDATE SET
        paused = ${paused},
        paused_at = ${paused ? sql`now()` : sql`NULL`},
        updated_at = now()
    `);
  }
}
