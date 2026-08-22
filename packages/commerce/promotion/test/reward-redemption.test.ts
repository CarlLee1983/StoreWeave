import { describe, expect, it } from 'vitest';
import { calculatePricing, type Promotion, type PricingLineInput } from '@storeweave/promotion';

/** 購物金折抵在定價中的位置（工單 41）。 */

const AT = new Date('2026-08-22T00:00:00.000Z');

const line = (unitPriceCents: number, quantity = 1, id = `l${unitPriceCents}`): PricingLineInput => ({
  lineId: id, productId: `p${unitPriceCents}`, unitPriceCents, quantity,
});

const tenPercentOff: Promotion = {
  id: 'promo-1', name: '全站九折', priority: 0, stackable: true, startsAt: null, endsAt: null,
  rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
};

describe('購物金折抵', () => {
  it('是最後套用的一筆調整', () => {
    const result = calculatePricing({
      lines: [line(10_000)],
      context: { promotions: [tenPercentOff] },
      now: AT,
      rewardRedeemCents: 500,
    });

    expect(result.adjustments.map((a) => a.source)).toEqual(['promotion', 'reward']);
    expect(result.discountCents).toBe(1_500);
    expect(result.totalCents).toBe(8_500);
    expect(result.rewardRedeemedCents).toBe(500);
  });

  it('不影響活動的門檻判斷——折抵之後仍然算滿額', () => {
    const threshold: Promotion = {
      ...tenPercentOff, id: 'promo-2', name: '滿千折百',
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    };
    const result = calculatePricing({
      lines: [line(100_000)],
      context: { promotions: [threshold] },
      now: AT,
      rewardRedeemCents: 50_000,
    });

    // 門檻看的是商品小計，不是折抵後的金額。
    expect(result.discountCents).toBe(60_000);
    expect(result.totalCents).toBe(40_000);
  });

  it('不折運費與稅', () => {
    const result = calculatePricing({
      lines: [line(10_000)],
      context: { promotions: [] },
      now: AT,
      shippingCents: 6_000,
      taxCents: 500,
      rewardRedeemCents: 99_999,
    });

    // 折抵吃掉整個商品小計就停手，運費與稅原封不動。
    expect(result.discountCents).toBe(10_000);
    expect(result.totalCents).toBe(6_500);
    expect(result.rewardRedeemedCents).toBe(10_000);
  });

  it('折抵不會讓應付金額變成負數', () => {
    const result = calculatePricing({
      lines: [line(3_000)],
      context: { promotions: [tenPercentOff] },
      now: AT,
      rewardRedeemCents: 100_000,
    });

    expect(result.totalCents).toBe(0);
    // 活動已經折掉 300，購物金最多再折 2,700。
    expect(result.rewardRedeemedCents).toBe(2_700);
  });

  it('分攤到商品行的規則與其他調整一致，行折扣合計等於訂單折扣', () => {
    const result = calculatePricing({
      lines: [line(3_333, 3, 'a'), line(1_111, 2, 'b')],
      context: { promotions: [tenPercentOff] },
      now: AT,
      rewardRedeemCents: 1_234,
    });

    const lineDiscounts = result.lines.reduce((sum, l) => sum + l.discountCents, 0);
    expect(lineDiscounts).toBe(result.discountCents);
    expect(result.lines.every((l) => l.netCents >= 0)).toBe(true);
    // 每一行都看得出購物金折抵那一筆，退貨時才算得回來。
    expect(result.lines.flatMap((l) => l.adjustments).filter((a) => a.source === 'reward').length).toBeGreaterThan(0);
  });

  it('沒有指定折抵時什麼都不變', () => {
    const result = calculatePricing({ lines: [line(10_000)], context: { promotions: [] }, now: AT });
    expect(result.rewardRedeemedCents).toBe(0);
    expect(result.adjustments).toEqual([]);
  });
});
