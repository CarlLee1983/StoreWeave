import { Cron } from 'croner';
import { PlatformError } from '@storeweave/contracts';

/**
 * 排程宣告的解析與時間運算。
 *
 * 這個檔案只做「什麼時候該跑」的純計算，一次資料庫都不碰，也不持有任何 timer。
 * 「跑」這件事仍然只有一條路：算出 occurrence → enqueue → 由同一個 worker 從佇列取出執行。
 * 詳見 ADR 0038；croner 的 scheduler 面（schedule／trigger／stop／pause／name）在這裡不能出現。
 *
 * 兩種宣告：
 * - `everyMs` 固定間隔，沿用 ADR 0016 的 epoch 對齊切片，去重鍵與遷移前完全相同。
 * - `cron` 加 IANA 時區，用來表達本地午夜、月底、每月第一個星期一這類切片表達不了的排程。
 */

/** 一次列舉最多算幾個 occurrence；長期停機不該算出無界的清單。 */
export const MAX_OCCURRENCES_PER_SCAN = 1_000;

export type OverlapPolicy = 'queue' | 'skip';

/** 模組寫在 `PlatformModule.jobs[].schedule` 上的宣告。 */
export interface IntervalScheduleDeclaration {
  readonly everyMs: number;
  /** 停機後最多補排幾次；預設 1，也就是只補最近的那一次。 */
  readonly catchUp?: number;
  /** 上一次還在佇列或執行中時要不要再排；預設 queue。 */
  readonly overlap?: OverlapPolicy;
}

export interface CronScheduleDeclaration {
  readonly cron: string;
  /** IANA 時區識別碼。必填：DST 行為不能靠行程的本地時區猜。 */
  readonly timezone: string;
  readonly catchUp?: number;
  readonly overlap?: OverlapPolicy;
}

export type ScheduleDeclaration = IntervalScheduleDeclaration | CronScheduleDeclaration;

interface ScheduleCommon {
  readonly catchUp: number;
  readonly overlap: OverlapPolicy;
  /** 宣告的正規化字串，存進排程狀態列，用來偵測宣告變更。 */
  readonly fingerprint: string;
}

export interface IntervalSchedule extends ScheduleCommon {
  readonly kind: 'interval';
  readonly everyMs: number;
}

export interface CronSchedule extends ScheduleCommon {
  readonly kind: 'cron';
  readonly cron: string;
  readonly timezone: string;
}

export type ScheduleSpec = IntervalSchedule | CronSchedule;

function isCronDeclaration(declaration: ScheduleDeclaration): declaration is CronScheduleDeclaration {
  return 'cron' in declaration;
}

/**
 * 縮寫在不同國家指向不同位移，而 Node 的 `Intl` 會**照收**並解析成一個多數人猜不到的城市：
 * 實測 `CST` → `America/Chicago`（不是台北也不是北京），`EST` → `America/Panama`。
 * 這種靜默的錯誤位移比啟動失敗糟得多，所以明確擋掉。
 */
const AMBIGUOUS_TIMEZONE_ABBREVIATIONS = new Set([
  // 北美
  'CST', 'EST', 'MST', 'HST', 'PST', 'EDT', 'CDT', 'MDT', 'PDT',
  'EST5EDT', 'CST6CDT', 'MST7MDT', 'PST8PDT',
  // 世界上最歧義的兩個。實測：`BST` → `Asia/Dhaka`（不是英國夏令，而且孟加拉沒有 DST）、
  // `IST` → `Asia/Calcutta`（印度、愛爾蘭、以色列共用這個縮寫，Intl 選了印度）。
  'IST', 'BST',
]);
// 刻意放行：`CET`／`EET`／`WET`／`MET` 是有真實 DST 規則的 legacy 區名（→ Europe/*），
// `JST`／`ROK`／`PRC` 只對應一個國家，不歧義。

function assertValidTimezone(type: string, timezone: unknown): asserts timezone is string {
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw PlatformError.validation(`Schedule "${type}" needs an IANA timezone alongside cron`);
  }
  if (AMBIGUOUS_TIMEZONE_ABBREVIATIONS.has(timezone.toUpperCase())) {
    throw PlatformError.validation(
      `Schedule "${type}" timezone "${timezone}" is an ambiguous abbreviation; use a Region/City identifier`,
    );
  }
  // `Etc/GMT+8` 的正負號與直覺相反（實際是 UTC−8），宣告成「台北時間」會安靜地差 16 小時。
  if (/^Etc\/GMT[+-]/i.test(timezone)) {
    throw PlatformError.validation(
      `Schedule "${type}" timezone "${timezone}" has inverted sign semantics; use a Region/City identifier`,
    );
  }
  try {
    // 其餘交給 Intl 判斷。`Japan`／`Singapore`／`NZ` 這類 backward link 是合法的，不該被擋。
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw PlatformError.validation(`Schedule "${type}" has an unknown timezone "${timezone}"`);
  }
}

function parseCommon(type: string, declaration: ScheduleDeclaration): { catchUp: number; overlap: OverlapPolicy } {
  const catchUp = declaration.catchUp ?? 1;
  if (!Number.isSafeInteger(catchUp) || catchUp < 1) {
    throw PlatformError.validation(`Schedule "${type}" needs a positive integer catchUp`);
  }
  const overlap = declaration.overlap ?? 'queue';
  if (overlap !== 'queue' && overlap !== 'skip') {
    throw PlatformError.validation(`Schedule "${type}" has an unknown overlap policy "${overlap}"`);
  }
  return { catchUp, overlap };
}

/** 註冊時解析並驗證宣告；任何無效輸入在這裡就變成啟動失敗，而不是半夜漏跑。 */
export function parseScheduleSpec(type: string, declaration: ScheduleDeclaration): ScheduleSpec {
  const { catchUp, overlap } = parseCommon(type, declaration);

  if (isCronDeclaration(declaration)) {
    assertValidTimezone(type, declaration.timezone);
    let cron: Cron;
    try {
      // 建構子只驗語法；這個實例不會被留下來排任何東西。
      cron = new Cron(declaration.cron, { timezone: declaration.timezone });
    } catch (error) {
      throw PlatformError.validation(
        `Schedule "${type}" has an invalid cron expression "${declaration.cron}": ${(error as Error).message}`,
      );
    }

    const spec: CronSchedule = {
      kind: 'cron',
      cron: declaration.cron,
      timezone: declaration.timezone,
      catchUp,
      overlap,
      fingerprint: `cron:${declaration.cron}@${declaration.timezone}`,
    };

    // 語法合法不等於算得出時間。`0 0 30 2 *` 這種永遠不會發生的組合建構子照收，
    // 而回推在某些樣式上會丟例外。兩個方向都在這裡探一次，讓問題變成啟動失敗，
    // 而不是每一輪 tick 都在 worker 裡炸開。
    const now = new Date();
    if (cron.nextRuns(1, now).length === 0) {
      throw PlatformError.validation(
        `Schedule "${type}" cron expression "${declaration.cron}" never occurs`,
      );
    }
    cronRunsAtOrBefore(spec, now, 1);

    return spec;
  }

  if (!Number.isFinite(declaration.everyMs) || declaration.everyMs <= 0) {
    throw PlatformError.validation(`Schedule "${type}" needs a positive everyMs`);
  }
  return {
    kind: 'interval',
    everyMs: declaration.everyMs,
    catchUp,
    overlap,
    fingerprint: `interval:${declaration.everyMs}`,
  };
}

/**
 * 正向掃描回推時，最多往前看這麼久。
 *
 * 規則是「必須涵蓋 `count + 1` 個間距」，不是 `count` 個：要拿到最近兩次，視窗得跨過三個邊界。
 * 閏日的最大間距是 8 年（2096 → 2104，因為 2100 不是閏年），所以 `count = 2` 需要 24 年才安全。
 */
const BACKWARD_FALLBACK_WINDOW_MS = 24 * 366 * 24 * 60 * 60 * 1_000;

/**
 * fallback 的結果快取。
 *
 * `occurrencesBetween` 每一輪 tick 都會呼叫，而 fallback 的 `nextRuns(1000, …)` 對閏日排程
 * 實測要 78 ms——那是在持有排程列寫鎖的交易之內。
 *
 * 有效期不是「同一天」而是「還沒跨過下一次」：答案只在 `at` 跨過某一次 occurrence 時才變，
 * 而 occurrence 落在當地時區，跟 UTC 日界不對齊。按 UTC 日快取會讓 Asia/Taipei 的閏日
 * occurrence 遲到八小時才排得出來（偏移愈大愈久，上界一整天），所以改記真正的有效區間。
 */
interface BackwardFallbackEntry {
  readonly result: Date[];
  /** 這份答案在 `[validFrom, validUntil)` 內都成立。 */
  readonly validFrom: number;
  readonly validUntil: number;
}

const backwardFallbackCache = new Map<string, BackwardFallbackEntry>();

const copyOf = (runs: Date[]): Date[] => runs.map((run) => new Date(run.getTime()));

/**
 * 不晚於 `at` 的最近 `count` 次，由新到舊。
 *
 * croner 回推前會先退一秒，所以要含 `at` 本身就得往後推一整秒，不是一毫秒。
 *
 * croner 10.0.1 的 `previousRuns` 在指定日期加上該月不一定存在的組合上會丟 TypeError
 * （實測 `0 0 29 2 *`、`0 0 31 4 *` 皆然，而 `nextRuns` 正常）。閏日排程是合法的，
 * 不能因為套件回推不了就讓 worker 在每一輪 tick 炸掉，所以這裡改用有界的正向掃描補回來。
 * 會走到 fallback 的都是「指定月＋指定日」這類稀疏樣式，正向掃描很快就跨過視窗。
 */
function cronRunsAtOrBefore(spec: CronSchedule, at: Date, count: number): Date[] {
  const cron = new Cron(spec.cron, { timezone: spec.timezone });
  const from = new Date(at.getTime() + 1_000);
  try {
    return cron.previousRuns(count, from);
  } catch {
    return backwardByForwardScan(cron, spec, at, count);
  }
}

function backwardByForwardScan(cron: Cron, spec: CronSchedule, at: Date, count: number): Date[] {
  const key = `${spec.fingerprint}|${count}`;
  const hit = backwardFallbackCache.get(key);
  // 回傳複本連同元素一起複製：呼叫端對 Date 做任何就地變動都會污染快取，
  // 而污染之後連 validFrom／validUntil 的比較都跟著失真。
  if (hit && at.getTime() >= hit.validFrom && at.getTime() < hit.validUntil) return copyOf(hit.result);
  const windowStart = new Date(at.getTime() - BACKWARD_FALLBACK_WINDOW_MS);
  const forward = cron.nextRuns(MAX_OCCURRENCES_PER_SCAN, windowStart);
  const upTo = forward.filter((run) => run.getTime() <= at.getTime());
  // 掃描上限內沒有跨過 `at`，代表這個樣式密到正向掃描答不出來。與其安靜地回一個
  // 錯的「上一次」，不如讓它變成註冊期的錯誤——`parseScheduleSpec` 會先探一次。
  if (upTo.length === forward.length && forward.length === MAX_OCCURRENCES_PER_SCAN) {
    throw PlatformError.validation(
      `Cron expression "${spec.cron}" cannot be enumerated backwards within the supported window`,
    );
  }
  const result = upTo.slice(-count).reverse();
  // 有效區間的下界是這份答案裡最新的那一次（再早就會少一次），上界是還沒被納入的下一次。
  // 掃描視窗內找不到下一次時不快取：與其猜一個上界，不如下一輪重算。
  const nextRun = forward[upTo.length];
  if (nextRun) {
    if (backwardFallbackCache.size > 256) backwardFallbackCache.clear();
    backwardFallbackCache.set(key, {
      result,
      // 答案為空時下界是掃描視窗的起點，不是負無限：更早的 `at` 會帶著一個更早的視窗，
      // 那個視窗可能含有這裡看不到的 occurrence。
      validFrom: result[0]?.getTime() ?? windowStart.getTime(),
      validUntil: nextRun.getTime(),
    });
  }
  return copyOf(result);
}

/** 不晚於 `at` 的最近一次預定時刻；還沒有任何一次就回 undefined。 */
export function currentOccurrence(spec: ScheduleSpec, at: Date): Date | undefined {
  if (spec.kind === 'interval') {
    return new Date(Math.floor(at.getTime() / spec.everyMs) * spec.everyMs);
  }
  return cronRunsAtOrBefore(spec, at, 1)[0];
}

/**
 * `(after, until]` 之間的每一次預定時刻，由舊到新。
 * 超過 `limit` 時保留最靠近 `until` 的那幾次——停機太久時該補的是最近的，不是最舊的。
 */
export function occurrencesBetween(
  spec: ScheduleSpec,
  after: Date,
  until: Date,
  limit: number = MAX_OCCURRENCES_PER_SCAN,
): Date[] {
  if (until.getTime() <= after.getTime()) return [];

  if (spec.kind === 'interval') {
    const firstBucket = Math.floor(after.getTime() / spec.everyMs) + 1;
    const lastBucket = Math.floor(until.getTime() / spec.everyMs);
    if (lastBucket < firstBucket) return [];
    const start = Math.max(firstBucket, lastBucket - limit + 1);
    const runs: Date[] = [];
    for (let bucket = start; bucket <= lastBucket; bucket += 1) {
      runs.push(new Date(bucket * spec.everyMs));
    }
    return runs;
  }

  // croner 由新往舊回推，取到 limit 或跨過 after 為止。
  const descending = cronRunsAtOrBefore(spec, until, limit);
  const runs = descending.filter((run) => run.getTime() > after.getTime());
  return runs.reverse();
}

/**
 * occurrence 的去重鍵，也就是它在佇列裡的身分。
 *
 * 間隔式**刻意**沿用 ADR 0016 的 `recurring:<type>:<bucket>`：遷移當下同一個切片算出同一個鍵，
 * 舊行程與新行程不會各排一次。cron 另走 `:at:` 前綴，兩種格式不可能相撞。
 */
export function scheduleOccurrenceKey(type: string, spec: ScheduleSpec, occurrenceAt: Date): string {
  if (spec.kind === 'interval') {
    return occurrenceKeyFor(type, bucketFor(occurrenceAt, spec.everyMs));
  }
  return `recurring:${type}:at:${occurrenceAt.getTime()}`;
}

/** 這個時刻落在第幾個切片。間隔式排程的 occurrence 身分。 */
export function bucketFor(at: Date, everyMs: number): number {
  return Math.floor(at.getTime() / everyMs);
}

/** 一個切片對應唯一一個去重鍵；換切片就換鍵。 */
export function occurrenceKeyFor(type: string, bucket: number): string {
  return `recurring:${type}:${bucket}`;
}

/**
 * occurrence 的 payload。
 *
 * 間隔式**維持與 ADR 0016 完全相同的欄位**（`bucket` + `scheduledFor`）：既有模組的
 * `jobContractV1` v1 schema 是 `.strict()` 的，少一個欄位會讓遷移當下在途的工作被 quarantine。
 * cron 沒有切片編號，只帶 `scheduledFor`；改用 cron 的模組要自己宣告對應的 payload 版本。
 */
export function scheduleOccurrencePayload(spec: ScheduleSpec, occurrenceAt: Date): Record<string, unknown> {
  const scheduledFor = occurrenceAt.toISOString();
  if (spec.kind === 'interval') {
    return { bucket: bucketFor(occurrenceAt, spec.everyMs), scheduledFor };
  }
  return { scheduledFor };
}

/**
 * 第一次見到某個排程時的 watermark：**當下這一次的前一次**。
 *
 * 這樣冷啟動後的第一輪剛好把「當下這一次」算成到期並排入，與 ADR 0016 的行為一致——
 * 若把 watermark 設成當下這一次，行程重啟就會安靜地少跑一次。
 */
export function coldStartWatermark(spec: ScheduleSpec, at: Date): Date | undefined {
  if (spec.kind === 'interval') {
    return new Date(Math.floor(at.getTime() / spec.everyMs) * spec.everyMs - spec.everyMs);
  }
  return cronRunsAtOrBefore(spec, at, 2)[1];
}

/** 晚於 `after` 的下一次預定時刻，純顯示用。 */
export function nextOccurrence(spec: ScheduleSpec, after: Date): Date | undefined {
  if (spec.kind === 'interval') {
    return new Date(Math.floor(after.getTime() / spec.everyMs) * spec.everyMs + spec.everyMs);
  }
  return new Cron(spec.cron, { timezone: spec.timezone }).nextRuns(1, after)[0];
}
