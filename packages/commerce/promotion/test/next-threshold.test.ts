import { describe, expect, it } from 'vitest';
import { calculatePricing, type Promotion, type PricingLineInput } from '@storeweave/promotion';

/** 「還差多少就有折扣」的提示（工單 29）。 */

const AT = new Date('2026-08-22T00:00:00.000Z');

const line = (unitPriceCents: number, quantity = 1): PricingLineInput => ({
  lineId: `line-${unitPriceCents}`, productId: `product-${unitPriceCents}`, unitPriceCents, quantity,
});

function promotion(overrides: Partial<Promotion> & { rule: Promotion['rule'] }): Promotion {
  return {
    id: 'promo-1', name: '滿千折百', priority: 0, stackable: true, startsAt: null, endsAt: null,
    ...overrides,
  };
}

const nextThresholdOf = (promotions: Promotion[], subtotalCents: number) =>
  calculatePricing({ lines: [line(subtotalCents)], context: { promotions }, now: AT }).nextThreshold;

describe('還差多少達到門檻', () => {
  it('沒有門檻活動時沒有提示', () => {
    expect(nextThresholdOf([], 50_000)).toBeNull();
    expect(nextThresholdOf([promotion({ rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 } })], 50_000))
      .toBeNull();
  });

  it('還沒達到門檻時說得出還差多少', () => {
    const promotions = [promotion({
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    })];

    expect(nextThresholdOf(promotions, 60_000)).toEqual({
      promotionId: 'promo-1', name: '滿千折百', thresholdCents: 100_000, remainingCents: 40_000,
    });
  });

  it('已經達到的門檻不再提示', () => {
    const promotions = [promotion({
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    })];
    expect(nextThresholdOf(promotions, 100_000)).toBeNull();
  });

  it('多個未達成的門檻取最近的那一個', () => {
    const promotions = [
      promotion({ id: 'far', name: '滿五千送', rule: { type: 'threshold_fixed_amount', thresholdCents: 500_000, discountCents: 50_000 } }),
      promotion({ id: 'near', name: '滿兩千折兩百', rule: { type: 'threshold_percentage', thresholdCents: 200_000, percentOffBasisPoints: 1_000 } }),
    ];

    expect(nextThresholdOf(promotions, 150_000)).toMatchObject({ promotionId: 'near', remainingCents: 50_000 });
  });

  it('還沒開始或已經結束的活動不提示——提示了顧客也拿不到', () => {
    const promotions = [promotion({
      startsAt: new Date('2026-09-01T00:00:00.000Z'),
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    })];
    expect(nextThresholdOf(promotions, 60_000)).toBeNull();
  });

  it('差距相同時以優先序決定，優先序也相同時以 id 決定——輸出與輸入順序無關', () => {
    const rule = { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 } as const;
    const a = promotion({ id: 'aaa', name: 'A', priority: 5, rule });
    const b = promotion({ id: 'bbb', name: 'B', priority: 1, rule });

    expect(nextThresholdOf([a, b], 60_000)!.promotionId).toBe('bbb');
    expect(nextThresholdOf([b, a], 60_000)!.promotionId).toBe('bbb');
  });
});
