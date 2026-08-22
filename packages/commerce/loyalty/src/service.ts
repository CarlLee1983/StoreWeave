import { randomUUID } from 'node:crypto';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { deriveRewardBalance, type RewardBalance } from './balance';
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

export { LoyaltyRepository };
