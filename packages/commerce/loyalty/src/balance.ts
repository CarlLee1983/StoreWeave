/**
 * 購物金餘額的推導。
 *
 * 餘額不是欄位，是帳本的推導值——欄位會被寫壞，推導值不會。代價是這支函式：
 * 每一批有自己的生效日與到期日，而扣抵**先用先到期的那一批**，
 * 因此不能單純加總，要按批次排序後才知道用掉哪些。這是分批帳本唯一的複雜之處。
 */

export interface RewardEntry {
  id: string;
  /** 正數是入帳，負數是折抵或回沖。 */
  amountCents: number;
  /** 這一批什麼時候開始可用。 */
  effectiveAt: Date;
  /** 什麼時候過期；null 是不過期。 */
  expiresAt: Date | null;
  createdAt: Date;
}

export interface RewardBatch {
  id: string;
  /** 這一批原本有多少。 */
  amountCents: number;
  /** 扣掉已經用掉的之後還剩多少。 */
  remainingCents: number;
  effectiveAt: Date;
  expiresAt: Date | null;
}

export interface RewardBalance {
  /** 現在就能用的金額。 */
  availableCents: number;
  /** 已經入帳但還沒生效的金額。顧客看到它才不會以為系統壞了。 */
  pendingCents: number;
  /** 已經過期而沒用掉的金額。 */
  expiredCents: number;
  /** 還有餘額的批次，依「先到期的先用」排序。 */
  batches: RewardBatch[];
}

/** 先到期的先用；不過期的排最後。同時間則以入帳順序決定，讓結果與輸入順序無關。 */
function byExpiryThenAge(a: RewardBatch, b: RewardBatch): number {
  if (a.expiresAt && b.expiresAt) {
    const diff = a.expiresAt.getTime() - b.expiresAt.getTime();
    if (diff !== 0) return diff;
  } else if (a.expiresAt || b.expiresAt) {
    return a.expiresAt ? -1 : 1;
  }
  const age = a.effectiveAt.getTime() - b.effectiveAt.getTime();
  return age !== 0 ? age : a.id.localeCompare(b.id);
}

/**
 * 依時間順序把扣抵分配到各批次上。
 *
 * 扣抵按帳本順序處理，每一筆都用「當下該優先用掉的批次」——也就是先到期的那一批。
 * 沒有足夠的批次可扣時，剩下的部分就丟掉：那代表帳本本身有問題，而讓餘額變成負數
 * 只會把問題藏起來。
 */
export function deriveRewardBalance(entries: readonly RewardEntry[], now: Date): RewardBalance {
  // 同一時刻的分錄先算入帳再算扣抵：扣抵只能花掉已經存在的錢，
  // 反過來排會讓一筆本來抵銷得掉的扣抵落空。
  const ordered = [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      || Math.sign(b.amountCents) - Math.sign(a.amountCents)
      || a.id.localeCompare(b.id),
  );

  const batches: RewardBatch[] = [];
  for (const entry of ordered) {
    if (entry.amountCents > 0) {
      batches.push({
        id: entry.id,
        amountCents: entry.amountCents,
        remainingCents: entry.amountCents,
        effectiveAt: entry.effectiveAt,
        expiresAt: entry.expiresAt,
      });
      continue;
    }
    let owed = -entry.amountCents;
    // 扣抵發生在它自己的時點：那時還沒過期的批次才扣得到。
    const usable = batches
      .filter((batch) => batch.remainingCents > 0 && !isExpiredAt(batch, entry.createdAt))
      .sort(byExpiryThenAge);
    for (const batch of usable) {
      if (owed <= 0) break;
      const take = Math.min(batch.remainingCents, owed);
      batch.remainingCents -= take;
      owed -= take;
    }
  }

  let availableCents = 0;
  let pendingCents = 0;
  let expiredCents = 0;
  const remaining: RewardBatch[] = [];

  for (const batch of batches) {
    if (batch.remainingCents <= 0) continue;
    if (isExpiredAt(batch, now)) {
      expiredCents += batch.remainingCents;
      continue;
    }
    if (batch.effectiveAt.getTime() > now.getTime()) {
      pendingCents += batch.remainingCents;
    } else {
      availableCents += batch.remainingCents;
    }
    remaining.push(batch);
  }

  return { availableCents, pendingCents, expiredCents, batches: remaining.sort(byExpiryThenAge) };
}

function isExpiredAt(batch: { expiresAt: Date | null }, at: Date): boolean {
  // 含頭不含尾，與定價引擎的期間判斷一致。
  return batch.expiresAt !== null && batch.expiresAt.getTime() <= at.getTime();
}

/**
 * 這次結帳最多能折抵多少：可用餘額與商品小計的較小值。
 * 折抵不能讓應付金額變成負數，也不折運費與稅。
 */
export function maxRedeemableCents(availableCents: number, subtotalCents: number): number {
  return Math.max(0, Math.min(availableCents, subtotalCents));
}
