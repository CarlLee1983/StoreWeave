import { randomUUID } from 'node:crypto';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { deriveRewardBalance, type RewardBalance } from './balance';
import { deriveTier, multiplierOf, type TierDefinition, type TierStatus } from './tier';
import { LoyaltyRepository } from './repository';
import type { RewardEntryRow } from './schema';

const repository = new LoyaltyRepository();

const DAY_MS = 24 * 60 * 60 * 1000;

function toEntry(row: RewardEntryRow) {
  return {
    id: row.id,
    amountCents: row.amountCents,
    effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * 購物金。餘額永遠是帳本的推導值——這一層只負責寫分錄與讀帳本，
 * 沒有任何地方存著「目前餘額」。
 */
export const rewardService = {
  async balanceFor(db: DrizzleDb | Tx, customerId: string, now: Date): Promise<RewardBalance> {
    return deriveRewardBalance((await repository.rewardEntriesFor(db, customerId)).map(toEntry), now);
  },

  /**
   * 付款完成時累積。生效日往後推 N 天：給太早會被套利
   * （下單拿金、取消訂單、購物金留著），往後推之後取消回沖只是扣掉一筆
   * 還沒生效的分錄，餘額不會變負數。
   *
   * `multiplier` 由會員等級決定（工單 45）；沒有等級時是 1。
   */
  async accrueForOrder(
    tx: Tx,
    input: { customerId: string; orderId: string; netCents: number; now: Date; multiplier?: number },
  ): Promise<RewardEntryRow | null> {
    const settings = await repository.settings(tx);
    const base = Math.floor((input.netCents * settings.accrualBasisPoints) / 10_000);
    const amountCents = Math.floor(base * (input.multiplier ?? 1));
    if (amountCents <= 0) return null;

    const effectiveAt = new Date(input.now.getTime() + settings.effectiveAfterDays * DAY_MS);
    return repository.addRewardEntry(tx, {
      id: randomUUID(),
      customerId: input.customerId,
      amountCents,
      source: 'order-accrual',
      reference: input.orderId,
      effectiveAt,
      // 到期日從**生效日**起算，不是從入帳日：否則七天的等待期會白白吃掉可用時間。
      expiresAt: settings.expiresAfterDays === null
        ? null
        : new Date(effectiveAt.getTime() + settings.expiresAfterDays * DAY_MS),
      actorId: null,
      reason: null,
      createdAt: input.now,
    });
  },

  /** 結帳折抵。負分錄，立刻生效、不過期——它只是把已經有的錢用掉。 */
  async redeemForOrder(
    tx: Tx,
    input: { customerId: string; orderId: string; amountCents: number; now: Date },
  ): Promise<RewardEntryRow | null> {
    if (input.amountCents <= 0) return null;
    return repository.addRewardEntry(tx, {
      id: randomUUID(),
      customerId: input.customerId,
      amountCents: -input.amountCents,
      source: 'redemption',
      reference: input.orderId,
      effectiveAt: input.now,
      expiresAt: null,
      actorId: null,
      reason: null,
      createdAt: input.now,
    });
  },

  /**
   * 訂單取消時的回沖：折抵掉的還回去、那張單累積的扣回來。
   * 兩者都是**新的反向分錄**，不是把原本那一列改掉——帳本只增不改。
   */
  async reverseForOrder(
    tx: Tx,
    input: { customerId: string; orderId: string; now: Date },
  ): Promise<{ refundedCents: number; clawedBackCents: number }> {
    const entries = await repository.rewardEntriesFor(tx, input.customerId);
    const forOrder = entries.filter((row) => row.reference === input.orderId);

    let refundedCents = 0;
    let clawedBackCents = 0;

    for (const row of forOrder) {
      if (row.source === 'redemption') refundedCents += -row.amountCents;
      if (row.source === 'order-accrual') clawedBackCents += row.amountCents;
    }

    if (refundedCents > 0) {
      await repository.addRewardEntry(tx, {
        id: randomUUID(),
        customerId: input.customerId,
        amountCents: refundedCents,
        source: 'reversal',
        reference: `refund:${input.orderId}`,
        effectiveAt: input.now,
        // 回沖的購物金不設到期日：顧客本來就已經擁有它，取消訂單不該縮短它的壽命。
        expiresAt: null,
        actorId: null,
        reason: null,
        createdAt: input.now,
      });
    }
    if (clawedBackCents > 0) {
      await repository.addRewardEntry(tx, {
        id: randomUUID(),
        customerId: input.customerId,
        amountCents: -clawedBackCents,
        source: 'reversal',
        reference: `clawback:${input.orderId}`,
        effectiveAt: input.now,
        expiresAt: null,
        actorId: null,
        reason: null,
        createdAt: input.now,
      });
    }
    return { refundedCents, clawedBackCents };
  },
};

/** 每消費一元累積一點。門檻因此讀得懂：「滿三千點」就是「一年內買滿三千元」。 */
export const TIER_POINTS_PER_CENT = 1 / 100;

function toTierDefinition(row: { name: string; thresholdPoints: number; multiplierBasisPoints: number }): TierDefinition {
  return { name: row.name, thresholdPoints: row.thresholdPoints, multiplierBasisPoints: row.multiplierBasisPoints };
}

/**
 * 等級積分與會員等級。
 *
 * 等級是帳本的推導值；`loyalty_customer_tiers` 只是讓定價的熱路徑不必每次
 * 重算整本帳的快取，真相永遠在 `deriveTier`。
 */
export const tierService = {
  async definitions(db: DrizzleDb | Tx): Promise<TierDefinition[]> {
    const rows = await repository.tiers(db);
    // 一級都沒有時給一個保底：沒有它，新會員不屬於任何等級，定價就沒有 membershipTier 可用。
    if (rows.length === 0) return [{ name: '一般會員', thresholdPoints: 0, multiplierBasisPoints: 10_000 }];
    return rows.map(toTierDefinition);
  },

  async statusFor(db: DrizzleDb | Tx, customerId: string, at: Date): Promise<TierStatus> {
    const [entries, definitions] = await Promise.all([
      repository.tierEntriesFor(db, customerId),
      this.definitions(db),
    ]);
    return deriveTier(entries.map((row) => ({ id: row.id, points: row.points, earnedAt: row.earnedAt })), definitions, at);
  },

  /** 定價與購物金倍率讀的是快取；讀不到就退回保底等級，而不是讓結帳失敗。 */
  async currentTierFor(db: DrizzleDb | Tx, customerId: string): Promise<TierDefinition> {
    const cached = await repository.customerTier(db, customerId);
    const definitions = await this.definitions(db);
    const found = cached ? definitions.find((tier) => tier.name === cached.tierName) : undefined;
    return found ?? definitions[0];
  },

  async multiplierFor(db: DrizzleDb | Tx, customerId: string): Promise<number> {
    return multiplierOf(await this.currentTierFor(db, customerId));
  },

  /** 付款完成時累積等級積分。與購物金同一個時機，但兩本帳分開記。 */
  async accrueForOrder(
    tx: Tx,
    input: { customerId: string; orderId: string; netCents: number; now: Date },
  ): Promise<void> {
    const points = Math.floor(input.netCents * TIER_POINTS_PER_CENT);
    if (points <= 0) return;
    await repository.addTierEntry(tx, {
      id: randomUUID(),
      customerId: input.customerId,
      points,
      source: 'order',
      reference: input.orderId,
      earnedAt: input.now,
      actorId: null,
      reason: null,
      createdAt: input.now,
    });
  },

  /** 訂單取消時扣回。與購物金一樣是新的反向分錄，不是把原本那一列改掉。 */
  async reverseForOrder(
    tx: Tx,
    input: { customerId: string; orderId: string; now: Date },
  ): Promise<void> {
    const entries = await repository.tierEntriesFor(tx, input.customerId);
    const earned = entries
      .filter((row) => row.source === 'order' && row.reference === input.orderId)
      .reduce((sum, row) => sum + row.points, 0);
    if (earned <= 0) return;
    await repository.addTierEntry(tx, {
      id: randomUUID(),
      customerId: input.customerId,
      points: -earned,
      source: 'reversal',
      reference: input.orderId,
      earnedAt: input.now,
      actorId: null,
      reason: null,
      createdAt: input.now,
    });
  },

  /**
   * 重算一位顧客的等級並寫回快取。回傳變動前後的等級，讓呼叫端決定要不要通知。
   * 重複執行同一段期間的結果相同——它算的是帳本，不是累加。
   */
  async recalculate(
    tx: Tx,
    customerId: string,
    at: Date,
  ): Promise<{ from: string | null; to: string; points: number; changed: boolean }> {
    const status = await this.statusFor(tx, customerId, at);
    const existing = await repository.customerTier(tx, customerId);
    const from = existing?.tierName ?? null;
    const changed = from !== status.current.name;

    await repository.saveCustomerTier(tx, {
      customerId,
      tierName: status.current.name,
      points: status.points,
      // 只有真的變動才更新「上一級」，否則重算兩次會把歷史洗掉。
      previousTierName: changed ? from : existing?.previousTierName ?? null,
      recalculatedAt: at,
    });
    return { from, to: status.current.name, points: status.points, changed };
  },
};

export { LoyaltyRepository };
