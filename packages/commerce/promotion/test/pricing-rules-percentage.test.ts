import { describe, expect, it } from 'vitest';
import { calculatePricing, type Promotion, type PricingLineInput } from '@storeweave/promotion';

const AT = new Date('2026-08-22T00:00:00.000Z');

function line(unitPriceCents: number, quantity = 1): PricingLineInput {
  return { lineId: 'line-1', productId: 'product-1', unitPriceCents, quantity };
}

function promo(id: string, rule: Promotion['rule'], overrides: Partial<Promotion> = {}): Promotion {
  return {
    id,
    name: id,
    priority: 0,
    stackable: true,
    startsAt: null,
    endsAt: null,
    rule,
    ...overrides,
  };
}

describe('滿額折百分比', () => {
  const rule = { type: 'threshold_percentage', thresholdCents: 200_000, percentOffBasisPoints: 1_000 } as const;

  it('剛好達門檻就套用', () => {
    const result = calculatePricing({ lines: [line(200_000)], context: { promotions: [promo('p', rule)] }, now: AT });
    expect(result.discountCents).toBe(20_000);
    expect(result.totalCents).toBe(180_000);
  });

  it('差一分不套用', () => {
    const result = calculatePricing({ lines: [line(199_999)], context: { promotions: [promo('p', rule)] }, now: AT });
    expect(result.discountCents).toBe(0);
  });

  it('折出小數時四捨五入到分', () => {
    // 200_005 的 10% 是 20_000.5
    const result = calculatePricing({ lines: [line(200_005)], context: { promotions: [promo('p', rule)] }, now: AT });
    expect(result.discountCents).toBe(20_001);
  });

  it('折扣上限會封頂', () => {
    const capped = { ...rule, maxDiscountCents: 5_000 };
    const result = calculatePricing({ lines: [line(500_000)], context: { promotions: [promo('p', capped)] }, now: AT });
    expect(result.discountCents).toBe(5_000);
  });
});

describe('整單百分比', () => {
  it('沒有門檻，一律套用', () => {
    const rule = { type: 'order_percentage', percentOffBasisPoints: 500 } as const;
    const result = calculatePricing({ lines: [line(1_234)], context: { promotions: [promo('p', rule)] }, now: AT });
    expect(result.discountCents).toBe(62); // 61.7 → 62
    expect(result.totalCents).toBe(1_172);
  });

  it('折扣上限會封頂', () => {
    const rule = { type: 'order_percentage', percentOffBasisPoints: 5_000, maxDiscountCents: 30_000 } as const;
    const result = calculatePricing({ lines: [line(100_000)], context: { promotions: [promo('p', rule)] }, now: AT });
    expect(result.discountCents).toBe(30_000);
  });
});

describe('優先序與疊加', () => {
  const tenPercent = { type: 'order_percentage', percentOffBasisPoints: 1_000 } as const;
  const fixedHundred = { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 } as const;

  it('依優先序套用，百分比算在尚未折抵的餘額上', () => {
    // 先折固定一百（100_000 → 餘 90_000），再打九折（-9_000）
    const discountFirst = calculatePricing({
      lines: [line(100_000)],
      context: {
        promotions: [promo('pct', tenPercent, { priority: 20 }), promo('fixed', fixedHundred, { priority: 10 })],
      },
      now: AT,
    });
    expect(discountFirst.appliedPromotions.map((p) => p.promotionId)).toEqual(['fixed', 'pct']);
    expect(discountFirst.discountCents).toBe(19_000);

    // 反過來：先打九折（-10_000），門檻仍看原始小計 100_000 所以滿額折成立，再折一百
    const percentFirst = calculatePricing({
      lines: [line(100_000)],
      context: {
        promotions: [promo('pct', tenPercent, { priority: 10 }), promo('fixed', fixedHundred, { priority: 20 })],
      },
      now: AT,
    });
    expect(percentFirst.appliedPromotions.map((p) => p.promotionId)).toEqual(['pct', 'fixed']);
    expect(percentFirst.discountCents).toBe(20_000);
  });

  it('輸入陣列的排列不影響結果', () => {
    const promotions = [promo('pct', tenPercent, { priority: 20 }), promo('fixed', fixedHundred, { priority: 10 })];
    const forward = calculatePricing({ lines: [line(100_000)], context: { promotions }, now: AT });
    const reversed = calculatePricing({ lines: [line(100_000)], context: { promotions: [...promotions].reverse() }, now: AT });
    expect(forward).toEqual(reversed);
  });

  it('兩個可疊加的活動都套用', () => {
    const result = calculatePricing({
      lines: [line(100_000)],
      context: {
        promotions: [
          promo('a', tenPercent, { priority: 10, stackable: true }),
          promo('b', tenPercent, { priority: 20, stackable: true }),
        ],
      },
      now: AT,
    });
    expect(result.appliedPromotions).toHaveLength(2);
    expect(result.discountCents).toBe(19_000);
  });

  it('不可疊加的活動套用後，後續不可疊加的活動不再套用', () => {
    const result = calculatePricing({
      lines: [line(100_000)],
      context: {
        promotions: [
          promo('exclusive-first', tenPercent, { priority: 10, stackable: false }),
          promo('exclusive-second', tenPercent, { priority: 20, stackable: false }),
        ],
      },
      now: AT,
    });
    expect(result.appliedPromotions.map((p) => p.promotionId)).toEqual(['exclusive-first']);
  });

  it('不可疊加的活動不阻擋可疊加的活動，可疊加的也不阻擋不可疊加的', () => {
    const result = calculatePricing({
      lines: [line(100_000)],
      context: {
        promotions: [
          promo('stackable', tenPercent, { priority: 10, stackable: true }),
          promo('exclusive', tenPercent, { priority: 20, stackable: false }),
          promo('stackable-late', tenPercent, { priority: 30, stackable: true }),
        ],
      },
      now: AT,
    });
    expect(result.appliedPromotions.map((p) => p.promotionId)).toEqual(['stackable', 'exclusive', 'stackable-late']);
  });

  it('條件不成立的不可疊加活動不會佔用名額', () => {
    const unreachable = { type: 'threshold_fixed_amount', thresholdCents: 999_999, discountCents: 10_000 } as const;
    const result = calculatePricing({
      lines: [line(100_000)],
      context: {
        promotions: [
          promo('never-applies', unreachable, { priority: 10, stackable: false }),
          promo('exclusive', tenPercent, { priority: 20, stackable: false }),
        ],
      },
      now: AT,
    });
    expect(result.appliedPromotions.map((p) => p.promotionId)).toEqual(['exclusive']);
  });
});

describe('活動期間的邊界時刻', () => {
  const rule = { type: 'order_percentage', percentOffBasisPoints: 1_000 } as const;
  const startsAt = new Date('2026-08-22T00:00:00.000Z');
  const endsAt = new Date('2026-08-23T00:00:00.000Z');
  const windowed = promo('p', rule, { startsAt, endsAt });

  const at = (iso: string) =>
    calculatePricing({ lines: [line(100_000)], context: { promotions: [windowed] }, now: new Date(iso) }).discountCents;

  it('開始前一毫秒不套用', () => {
    expect(at('2026-08-21T23:59:59.999Z')).toBe(0);
  });

  it('開始的那一刻套用（含頭）', () => {
    expect(at('2026-08-22T00:00:00.000Z')).toBe(10_000);
  });

  it('結束前一毫秒仍套用', () => {
    expect(at('2026-08-22T23:59:59.999Z')).toBe(10_000);
  });

  it('結束的那一刻不套用（不含尾）', () => {
    expect(at('2026-08-23T00:00:00.000Z')).toBe(0);
  });

  it('沒有設定期間的活動永遠套用', () => {
    const always = promo('p', rule);
    const result = calculatePricing({ lines: [line(100_000)], context: { promotions: [always] }, now: new Date('2099-01-01T00:00:00.000Z') });
    expect(result.discountCents).toBe(10_000);
  });
});
