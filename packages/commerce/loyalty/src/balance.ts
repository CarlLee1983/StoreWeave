/**
 * 購物金餘額的推導。
 *
 * 餘額不是欄位，是帳本的推導值——欄位會被寫壞，推導值不會。代價是這支函式：
 * 每一批有自己的生效日與到期日，而扣抵**先用先到期的那一批**，
 * 因此不能單純加總，要按批次排序後才知道用掉哪些。這是分批帳本唯一的複雜之處。
 *
 * 唯一的例外是**指名批次的扣回**（工單 54）：它要收回的是某一批具體的錢，
 * 先到期先用會讓它扣到別批頭上。有 `batchId` 就只扣那一批。
 */

export interface RewardEntry {
  id: string;
  /** 正數是入帳，負數是折抵或回沖。 */
  amountCents: number;
  /**
   * 這一筆負分錄要扣哪一批（指向那一批的入帳分錄 id）；null 是不指名。
   *
   * 指名的是**扣回**：取消訂單要收回的就是那張單累積的那一批，不是最先到期的那一批。
   * 不指名的是**折抵**：顧客花的是手上最快過期的錢，哪一批由推導決定。
   */
  batchId: string | null;
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
  /**
   * **不指名批次**的扣抵超過餘額而分配不掉的金額。正常情況恆為 0——不是 0 就代表
   * 帳本本身有問題，而讓它靜靜消失會讓那個問題事後查不出來。
   *
   * 指名批次的扣回不算在內：那一批可能已經被花掉，扣不回來是合法的結果。
   */
  shortfallCents: number;
  /**
   * 指名的扣回**沒扣到**的金額：那一批已經被花掉了。
   *
   * 這不是錯誤——收不回已經花掉的錢是回沖的合法結果——但它會讓推導值高於帳本總和，
   * 因為那筆負分錄計進了總和卻沒有扣到任何批次。完整的不變式是
   *
   *     可用 + 未生效 + 已過期 = 帳本總和 + shortfallCents + unappliedClawbackCents
   *
   * 兩個差額項都要在：分配不掉的量只走其中一條分支，少一項就會在另一種情況下對不起來。
   * 健康的帳本上 `shortfallCents` 恆為 0，所以實務上差額就是這個數字——但正是
   * `shortfallCents` 不為 0 的時候最需要分辨兩者，把它省掉會讓對帳的人把帳本壞掉
   * 誤讀成「錢已經花掉」。
   */
  unappliedClawbackCents: number;
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
 * 扣抵按帳本順序處理。不指名批次的那些用「當下該優先用掉的批次」——也就是先到期的
 * 那一批；指名的只扣它指名的那一批。沒有足夠的餘額可扣時，剩下的部分就丟掉：
 * 讓餘額變成負數只會把問題藏起來。
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
  let shortfall = 0;
  let unappliedClawback = 0;
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
    const usable = usableBatchesFor(entry, batches);
    for (const batch of usable) {
      if (owed <= 0) break;
      const take = Math.min(batch.remainingCents, owed);
      batch.remainingCents -= take;
      owed -= take;
    }
    // 分配不掉的部分不會讓餘額變成負數。不指名的扣抵扣不到就是帳本壞了；
    // 指名的扣回扣不到只代表那一批已經花掉了——不是錯誤，但也不能就這樣消失，
    // 否則推導值與帳本總和之間會留下一個沒有人查得到的差額。
    if (entry.batchId === null) shortfall += owed;
    else unappliedClawback += owed;
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

  return {
    availableCents,
    pendingCents,
    expiredCents,
    shortfallCents: shortfall,
    unappliedClawbackCents: unappliedClawback,
    batches: remaining.sort(byExpiryThenAge),
  };
}

/**
 * 這一筆負分錄扣得到哪些批次，依該扣的順序排好。
 *
 * 指名的只認那一批，生效與到期都不擋：它要收回的是那筆具體的錢。還沒生效正是取消
 * 訂單要扣的情況，已經過期則代表那一批從來沒被用掉——兩者都該扣得到，否則那筆錢會
 * 一直掛在未生效或已過期上，而帳本總和已經因為這筆負分錄少掉了。
 *
 * 不指名的先用最快過期的那一批，而且只扣「當下已生效、還沒過期」的：顧客花不到
 * 還沒生效的錢，少了這個條件，一筆折抵會吃掉還不能用的批次，可用餘額就看起來沒有變少。
 */
function usableBatchesFor(entry: RewardEntry, batches: readonly RewardBatch[]): RewardBatch[] {
  if (entry.batchId !== null) {
    return batches.filter((batch) => batch.id === entry.batchId && batch.remainingCents > 0);
  }
  return batches
    .filter((batch) => batch.remainingCents > 0
      && !isExpiredAt(batch, entry.createdAt)
      && batch.effectiveAt.getTime() <= entry.createdAt.getTime())
    .sort(byExpiryThenAge);
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
