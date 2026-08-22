import { PlatformError, type DrizzleDb, type Logger, type Tx } from '@storeweave/contracts';
import { PromotionRepository, tryToPromotionDto } from './repository';
import { calculatePricing } from './pricing/engine';
import type { PricingLineInput, PricingResult, Promotion } from './pricing/types';

/** 一次載入的活動數上限。超過這個數量的同時生效活動是設定錯誤，不是正常營運。 */
const MAX_ACTIVE_PROMOTIONS = 200;

const repository = new PromotionRepository();

export interface QuoteInput {
  lines: PricingLineInput[];
  /**
   * 需要券才套用的活動，由呼叫端明確指名。它們不在「此刻人人適用」的清單裡——
   * 建一張券不該等於全站打折。
   */
  couponPromotionIds?: readonly string[];
  /** 當下時間由呼叫端給，引擎與生效判斷用同一個值。 */
  now: Date;
  membershipTier?: string | null;
  shippingCents?: number;
  taxCents?: number;
  /** 購物金折抵。最後套用，只作用在商品小計上。上限由呼叫端算好。 */
  rewardRedeemCents?: number;
  /** 用來回報被跳過的壞活動。沒給就靜靜跳過。 */
  logger?: Logger;
}

/**
 * order 模組在同一個交易內呼叫這支：載入此刻生效中的活動，交給純函式引擎算。
 * 試算（無副作用的查詢）與結帳走的是同一支，兩者的結果因此必定一致。
 */
export const pricingService = {
  async activePromotions(
    db: DrizzleDb | Tx,
    at: Date,
    logger?: Logger,
    couponPromotionIds: readonly string[] = [],
  ): Promise<Promotion[]> {
    const items = await repository.listActiveAt(db, at, MAX_ACTIVE_PROMOTIONS);
    // 靜默截斷等於有些活動今天生效、明天不生效，而沒有人知道為什麼。
    if (items.length > MAX_ACTIVE_PROMOTIONS) {
      throw PlatformError.internal(
        `More than ${MAX_ACTIVE_PROMOTIONS} promotions are active at once; the pricing engine loads at most that many`,
      );
    }

    // 券指名的活動接在後面；排序仍由引擎依優先序決定，載入順序不影響結果。
    const named = await repository.listActiveByIds(db, couponPromotionIds, at);
    const promotions: Promotion[] = [];
    for (const row of [...items, ...named]) {
      // 一檔活動的規則參數壞掉，不該讓整間店關門——跳過它並留下紀錄。
      const dto = tryToPromotionDto(row);
      if (!dto) {
        logger?.error({ promotionId: row.id, ruleType: row.ruleType }, 'skipping promotion with invalid rule parameters');
        continue;
      }
      promotions.push({
        id: dto.id,
        name: dto.name,
        priority: dto.priority,
        stackable: dto.stackable,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        tierNames: dto.tierNames,
        rule: dto.rule,
      });
    }
    return promotions;
  },

  async quote(db: DrizzleDb | Tx, input: QuoteInput): Promise<PricingResult> {
    const promotions = await this.activePromotions(db, input.now, input.logger, input.couponPromotionIds);
    return calculatePricing({
      lines: input.lines,
      context: { promotions, membershipTier: input.membershipTier ?? null },
      now: input.now,
      shippingCents: input.shippingCents,
      taxCents: input.taxCents,
      rewardRedeemCents: input.rewardRedeemCents,
    });
  },
};
