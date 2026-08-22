/**
 * 會員等級的推導。
 *
 * 等級積分以**滾動十二個月**計算，因此會升也會降——只升不降的等級制在幾年後
 * 會讓所有人都是最高等級，那時等級就不再有意義。
 *
 * 等級積分不能折抵金額（`CONTEXT.md`）。它唯一的能力是決定等級，
 * 而等級唯一的能力是當定價引擎的一個輸入變數與購物金的倍率。
 */

export interface TierEntry {
  id: string;
  /** 正數是累積，負數是取消時的扣回。 */
  points: number;
  /** 這筆積分算在哪一天。滾動期間看的是它，不是寫進資料庫的時間。 */
  earnedAt: Date;
}

export interface TierDefinition {
  /** 對顧客顯示的名稱。 */
  name: string;
  /** 達到這個積分就是這一級。 */
  thresholdPoints: number;
  /** 購物金累積倍率，基點。10_000 = 1 倍。 */
  multiplierBasisPoints: number;
}

export interface TierStatus {
  /** 滾動期間內的積分總和，不會小於零。 */
  points: number;
  current: TierDefinition;
  /** 下一級與還差多少；已經是最高級時為 null。 */
  next: { tier: TierDefinition; remainingPoints: number } | null;
  /** 這段期間的起點。UI 要說得出「怎麼算出來的」，降級時才不會像被欺騙。 */
  windowStartsAt: Date;
}

/** 滾動期間的長度。十二個月是常見的一年制，但用月而不是 365 天，邊界才對得上月曆。 */
export const TIER_WINDOW_MONTHS = 12;

/**
 * 滾動期間的起點：`at` 往前推十二個月。
 *
 * `setUTCMonth` 在 2/29 會滑到 3/1（`months = 12` 時只影響閏日那一天）。
 * 那一天的顧客會少算一天的積分，比起自己實作月曆算術，這個誤差便宜得多。
 */
export function tierWindowStart(at: Date, months = TIER_WINDOW_MONTHS): Date {
  const start = new Date(at.getTime());
  start.setUTCMonth(start.getUTCMonth() - months);
  return start;
}

/** 依門檻由低到高排序，並確保永遠有一個保底等級。 */
function ordered(tiers: readonly TierDefinition[]): TierDefinition[] {
  return [...tiers].sort((a, b) => a.thresholdPoints - b.thresholdPoints);
}

/**
 * 滾動期間內的積分總和與對應的等級。
 *
 * 期間含頭不含尾，與定價引擎與券的期間判斷逐字相同：
 * 剛好落在起點那一刻的分錄算進來，落在 `at` 那一刻的也算。
 */
export function deriveTier(
  entries: readonly TierEntry[],
  tiers: readonly TierDefinition[],
  at: Date,
  months = TIER_WINDOW_MONTHS,
): TierStatus {
  const windowStartsAt = tierWindowStart(at, months);
  const points = Math.max(0, entries
    .filter((entry) => entry.earnedAt.getTime() >= windowStartsAt.getTime() && entry.earnedAt.getTime() <= at.getTime())
    .reduce((sum, entry) => sum + entry.points, 0));

  const sorted = ordered(tiers);
  if (sorted.length === 0) {
    throw new Error('deriveTier: at least one tier must be defined');
  }

  let current = sorted[0];
  let next: TierStatus['next'] = null;
  for (const tier of sorted) {
    if (points >= tier.thresholdPoints) {
      current = tier;
      next = null;
    } else {
      next = { tier, remainingPoints: tier.thresholdPoints - points };
      break;
    }
  }

  return { points, current, next, windowStartsAt };
}

/** 這一級的購物金倍率，寫成倍數。1 倍 = 沒有加成。 */
export function multiplierOf(tier: TierDefinition): number {
  return tier.multiplierBasisPoints / 10_000;
}
