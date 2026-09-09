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
  /** 這一輪算不出結果的排程數。連續累積代表有東西壞了，不是偶發抖動。 */
  readonly failed: number;
  /**
   * 這一輪預算不夠、留到下一輪的排程數。
   *
   * 與 `failed` 分開：延後是預算切太碎的資源問題，失敗是這個排程本身算不出結果，
   * 混在一起會讓「有東西壞了」的訊號被慢排程的雜訊蓋掉。
   */
  readonly deferred: number;
}

/** 單一排程的結果。`deferred` 是階段層級的事實，一個排程永遠不會延後自己。 */
export type EnsureOneResult = Omit<EnsureScheduledResult, 'deferred'>;

const EMPTY: EnsureOneResult = { enqueued: 0, skipped: 0, deduped: 0, failed: 0 };

/** 連續這麼多輪被 overlap 擋下就示警：多半代表上一次卡住了，而不是它真的很忙。 */
const OVERLAP_SKIP_WARN_THRESHOLD = 3;

/**
 * 連續這麼多輪算不出結果就升級成 error。
 *
 * 交易失敗時什麼都寫不進資料庫，所以這個計數只能留在行程內；它不需要跨行程精確，
 * 只需要讓「持續壞掉」與「偶發抖動」在 log 裡長得不一樣。
 */
const SCHEDULE_FAILURE_WARN_THRESHOLD = 3;

/**
 * 連續這麼多輪排不完就升級成 error。
 *
 * 偶爾延後是正常的（某一輪剛好撞上鎖等待），連續延後是容量訊號：排程數成長，
 * 或資料庫慢到一輪塞不下。後者需要有人處理，不該和前者長得一樣。
 */
const SCHEDULE_DEFERRAL_WARN_THRESHOLD = 3;

/**
 * 冷啟動（資料庫第一次見到這個排程，或宣告變更後重設）時，多舊的 occurrence 就不補了。
 *
 * ADR 0016 的「醒來時補當下這一次」對日排程最多陳舊一天，合理；外推到稀疏排程就不是了：
 * 一個閏日排程在 2026 年第一次部署，「當下這一次」是 2024-02-29，補下去等於立刻跑一次
 * 兩年半前的作業，而 handler 多半會照 `scheduledFor` 決定資料區間。
 *
 * 七天是刻意保守的界限：既有排程週期最長一天，行為完全不變；而新部署一個年度或閏日排程時，
 * 不會憑空跑出一次陳年帳。真的需要補跑歷史區間，那是領域問題，由 handler 或人工處理。
 * 注意這只約束冷啟動——已經在跑的排程遇到停機，走的是 watermark 與 `catchUp`，不受此限。
 */
const MAX_COLD_START_STALENESS_MS = 7 * 24 * 60 * 60 * 1_000;

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
  /** Worker 的輪詢間隔。用來在註冊時檢查宣告的頻率有沒有高過排程器實際被叫到的頻率。 */
  readonly pollIntervalMs?: number;
}

/** 直接呼叫（測試、維運）時的預設；worker 會傳自己的資料庫預算進來。 */
const DEFAULT_SCHEDULE_TIMEOUT_MS = 5_000;

/**
 * 預算剩不到這個數字就不再開新交易。
 *
 * `boundedTransaction` 逾時會 `client.release(error)` 把連線移出連線池，所以拿剩下的
 * 3 毫秒去開一個必定逾時的交易，代價是每輪毀一條連線——而它本來就排不完，
 * 直接留到下一輪即可。
 */
const MIN_SCHEDULE_SLICE_MS = 250;

export class RecurringScheduler {
  private readonly registered = new Map<string, ScheduleSpec>();
  /** 每個排程連續失敗幾輪。成功就歸零。 */
  private readonly consecutiveFailures = new Map<string, number>();
  /**
   * 下一輪要從哪個排程開始。
   *
   * `registered` 是插入順序（也就是啟動時 `register()` 的順序），每一輪都一樣；預算是
   * **整個階段**的總額，第一個排程在列鎖久等時就能自己吃滿。固定起點加上用完即 break，
   * 會讓順序靠後的排程無限期排不到，而外面只看到「一個排程偶爾抖動」。所以起點要輪替：
   * 這一輪停在誰身上，下一輪就從誰開始，跑完一整圈才回到頭。
   */
  private resumeFrom: string | undefined;
  /** 連續幾輪沒把整圈排完。排完一整圈就歸零。 */
  private consecutiveDeferrals = 0;

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
  async ensureScheduled(now: Date = new Date(), timeoutMs?: number): Promise<EnsureScheduledResult> {
    if (this.registered.size === 0) return { ...EMPTY, deferred: 0 };

    let enqueued = 0;
    let skipped = 0;
    let deduped = 0;
    let failed = 0;
    // 排程階段整體也要有界。逐個排程各給 5 秒，N 個排程就是 N×5 秒，而這一段排在
    // heartbeat 之後、relayOutbox／runJobs 之前——拖久了 heartbeat 會停更、佇列一起停擺，
    // 也違反 worker 的 `heartbeat + database + grace < lease` 不變式。
    const budget = timeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    const order = this.rotatedOrder();
    // 預算本身就小於一個切片時，切片跟著縮：與其開一個超出預算的交易，不如短一點。
    const minSlice = Math.min(MIN_SCHEDULE_SLICE_MS, budget);
    let deferred: string[] = [];
    for (const [index, [type, spec]] of order.entries()) {
      // 第一個一律排。降級成「這一輪少排幾個」是可以的，「一個都不排、而且每一輪都停在
      // 同一個位置」不是降級而是靜默停擺——預算小於一個切片時整份輪替就再也不會前進。
      if (index > 0 && deadline - Date.now() < minSlice) {
        // 被延後的**全部**都要進 log：只記邊界那一個，看 log 的人無從知道還有誰沒排到。
        deferred = order.slice(index).map(([deferredType]) => deferredType);
        this.resumeFrom = type;
        // 連續延後與連續失敗一樣要分級：預算長期不夠是容量訊號，需要有人處理，
        // 而不是每個 poll interval 印一行同樣的 warn 淹在雜訊裡。
        this.consecutiveDeferrals += 1;
        const log = this.consecutiveDeferrals >= SCHEDULE_DEFERRAL_WARN_THRESHOLD
          ? this.deps.logger.error
          : this.deps.logger.warn;
        log.call(this.deps.logger,
          { jobTypes: deferred, count: deferred.length, consecutive: this.consecutiveDeferrals },
          'scheduling phase ran out of budget; deferred to the next tick',
        );
        break;
      }
      this.resumeFrom = undefined;
      try {
        const result = await this.deps.database.boundedTransaction(
          Math.min(budget, Math.max(minSlice, deadline - Date.now())),
          `ensure schedule ${type}`,
          (tx) => this.ensureOne(tx, type, spec, now),
        );
        enqueued += result.enqueued;
        skipped += result.skipped;
        deduped += result.deduped;
        this.consecutiveFailures.delete(type);
      } catch (error) {
        failed += 1;
        // 排程是「確保」而不是「執行」：這一輪沒排到，下一輪會再算一次同一個 occurrence，
        // 去重鍵讓重試不會變成重複。一個排程的鎖等待或連線抖動不該讓整個 worker 停擺，
        // 也不該連帶擋掉同一輪的 relayOutbox 與 runJobs。
        // 一輪失敗是可以容忍的（下一輪會重算同一組 occurrence，去重鍵讓重試不變重複），
        // 但連續失敗代表有東西壞了，而不是抖動。兩者在 log 裡必須長得不一樣，
        // 否則一個從週五開始每輪逾時的排程只會被淹沒在每秒一行的訊息裡。
        const consecutive = (this.consecutiveFailures.get(type) ?? 0) + 1;
        this.consecutiveFailures.set(type, consecutive);
        const log = consecutive >= SCHEDULE_FAILURE_WARN_THRESHOLD ? this.deps.logger.error : this.deps.logger.warn;
        log.call(this.deps.logger,
          { jobType: type, consecutive, error: (error as Error).message },
          'schedule tick failed; will retry on the next tick',
        );
      }
    }
    if (deferred.length === 0) this.consecutiveDeferrals = 0;
    return { enqueued, skipped, deduped, failed, deferred: deferred.length };
  }

  /**
   * 這一輪的排程順序：從 `resumeFrom` 開始繞一圈回到原點。
   *
   * 找不到起點時防禦性地退回插入順序。目前 `registered` 沒有移除的路徑，所以這條走不到；
   * 輪替是公平性機制，將來若有人加上熱重載，也不該因為起點消失就讓整輪排不出來。
   */
  private rotatedOrder(): [string, ScheduleSpec][] {
    const entries = [...this.registered.entries()];
    if (!this.resumeFrom) return entries;
    const start = entries.findIndex(([type]) => type === this.resumeFrom);
    if (start <= 0) return entries;
    return [...entries.slice(start), ...entries.slice(0, start)];
  }

  /** 一個排程一個有界交易；呼叫端逐一 catch，所以某個排程的錯誤不會讓其他排程整輪停擺。 */
  private async ensureOne(tx: Tx, type: string, spec: ScheduleSpec, now: Date): Promise<EnsureOneResult> {
    const { row, coldStart } = await this.lockRow(tx, type, spec, now);
    const watermark = toDate(row.last_occurrence_at);
    if (!watermark) return EMPTY;

    const all = occurrencesBetween(spec, watermark, now, MAX_OCCURRENCES_PER_SCAN);
    if (all.length === 0) return EMPTY;

    const newest = all[all.length - 1];

    // 冷啟動不補陳年的 occurrence：見 MAX_COLD_START_STALENESS_MS。
    if (coldStart && now.getTime() - newest.getTime() > MAX_COLD_START_STALENESS_MS) {
      await this.advance(tx, type, newest, { catchup: all.length, paused: 0, overlap: 0 }, false, 0);
      this.deps.logger.info(
        { jobType: type, staleOccurrence: newest.toISOString(), skipped: all.length },
        'cold start skipped a stale occurrence; the schedule starts from the next one',
      );
      return { enqueued: 0, skipped: all.length, deduped: 0, failed: 0 };
    }
    // 追補有上限：停機太久時補最近的那幾次，不是最舊的那幾次。
    const due = all.slice(Math.max(0, all.length - spec.catchUp));
    const catchup = all.length - due.length;

    if (row.paused) {
      // 暫停期間的 occurrence 是「跳過」不是「延後」：恢復時不該一次湧出整段積壓。
      await this.advance(tx, type, newest, { catchup, paused: due.length, overlap: 0 }, false, 0);
      return { enqueued: 0, skipped: catchup + due.length, deduped: 0, failed: 0 };
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
      return { enqueued: 0, skipped: catchup + due.length, deduped: 0, failed: 0 };
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
    return { enqueued, skipped: catchup, deduped, failed: 0 };
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
  private async lockRow(
    tx: Tx, type: string, spec: ScheduleSpec, now: Date,
  ): Promise<{ row: ScheduleRow; coldStart: boolean }> {
    // anchor 只有「查無此列」「watermark 是 NULL」「宣告變了」三條分支用得到，
    // 而穩定狀態下三條都不會走。它對 cron 是一次 previousRuns，惰性求值才不會每輪白算。
    let cached: { anchor: Date | null } | undefined;
    const anchorOf = () => (cached ??= { anchor: coldStartWatermark(spec, now) ?? null }).anchor;
    const anchorSql = () => {
      const anchor = anchorOf();
      return anchor ? sql`CAST(${anchor.toISOString()} AS timestamptz)` : sql`NULL`;
    };

    let coldStart = false;
    let row = await this.selectForUpdate(tx, type);
    if (!row) {
      coldStart = true;
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
      coldStart = true;
      if (!anchorOf()) {
        this.deps.logger.warn(
          { jobType: type },
          'schedule has no computable previous occurrence; it will not enqueue until one exists',
        );
        return { row, coldStart };
      }
      const res = await tx.execute<ScheduleRow>(sql`
        UPDATE platform_job_schedules
        SET last_occurrence_at = ${anchorSql()}, fingerprint = ${spec.fingerprint}, updated_at = now()
        WHERE type = ${type}
        RETURNING ${SCHEDULE_COLUMNS}
      `);
      return { row: res.rows[0], coldStart };
    }

    if (row.fingerprint !== spec.fingerprint) {
      const res = await tx.execute<ScheduleRow>(sql`
        UPDATE platform_job_schedules
        SET fingerprint = ${spec.fingerprint}, last_occurrence_at = ${anchorSql()}, updated_at = now()
        WHERE type = ${type}
        RETURNING ${SCHEDULE_COLUMNS}
      `);
      // 宣告變更等同重新開始：新的時間表不該立刻補一次陳年的 occurrence。
      return { row: res.rows[0], coldStart: true };
    }
    return { row, coldStart };
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
   * overlap='skip' 的判準：同型別還有沒有沒跑完的工作。
   *
   * 排在未來、且**還沒跑過**的那一筆不算重疊——那是領域程式碼自己排的延後工作，
   * 不代表上一次還卡著。（排程器自己排的 occurrence 一律取自 `(watermark, now]`，
   * `run_at` 不會在未來，所以它從來不會擋住自己。）
   *
   * 但重試退避中的那一筆 `run_at` 也在未來，而它**確實**還沒跑完：退避上限 600 秒，
   * 對週期短於這個數字的排程來說，只看 `run_at` 會讓失敗中的工作被當成不存在，
   * 於是同型別愈堆愈多——正是 skip 要防的事。所以 `attempts > 0` 一律算重疊。
   */
  private async hasActiveJob(tx: Tx, type: string, now: Date): Promise<boolean> {
    const res = await tx.execute<{ one: number }>(sql`
      SELECT 1 AS one FROM platform_jobs
      WHERE type = ${type} AND status IN ('pending', 'running')
        AND (run_at <= CAST(${now.toISOString()} AS timestamptz) OR attempts > 0)
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
    // anchor 只有 INSERT 分支用得到；對閏日排程它是一次 78 ms 的 fallback 掃描，
    // 已存在的列不該為此付錢。與 lockRow 用同一種惰性處理。
    const existing = await tx.execute<{ one: number }>(sql`
      SELECT 1 AS one FROM platform_job_schedules WHERE type = ${type}
    `);
    const anchor = existing.rows.length > 0 ? null : coldStartWatermark(spec, now) ?? null;
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
