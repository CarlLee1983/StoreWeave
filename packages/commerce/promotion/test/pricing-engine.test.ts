import { describe, expect, it } from 'vitest';
import { calculatePricing, type Promotion, type PricingLineInput } from '@storeweave/promotion';

const AT = new Date('2026-08-22T00:00:00.000Z');

function line(overrides: Partial<PricingLineInput> = {}): PricingLineInput {
  return {
    lineId: 'line-1',
    productId: 'product-1',
    unitPriceCents: 50_000,
    quantity: 1,
    ...overrides,
  };
}

function thresholdFixed(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 'promo-1',
    name: '滿千折百',
    priority: 0,
    stackable: true,
    startsAt: null,
    endsAt: null,
    rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    ...overrides,
  };
}

describe('calculatePricing — 骨架', () => {
  it('沒有任何活動時總額等於商品小計', () => {
    const result = calculatePricing({
      lines: [line({ unitPriceCents: 30_000, quantity: 2 })],
      context: { promotions: [] },
      now: AT,
    });

    expect(result.subtotalCents).toBe(60_000);
    expect(result.discountCents).toBe(0);
    expect(result.totalCents).toBe(60_000);
    expect(result.adjustments).toEqual([]);
    expect(result.appliedPromotions).toEqual([]);
  });

  it('同樣的輸入永遠得到同樣的輸出', () => {
    const input = {
      lines: [line({ unitPriceCents: 33_333, quantity: 3 })],
      context: { promotions: [thresholdFixed()] },
      now: AT,
    };

    expect(calculatePricing(input)).toEqual(calculatePricing(input));
  });

  it('不修改傳入的商品行與情境', () => {
    const lines = [line({ unitPriceCents: 120_000 })];
    const context = { promotions: [thresholdFixed()] };
    const snapshot = JSON.stringify({ lines, context });

    calculatePricing({ lines, context, now: AT });

    expect(JSON.stringify({ lines, context })).toBe(snapshot);
  });

  it('未知的規則型別會出聲——靜默略過等於顧客少折錢而系統不吭聲', () => {
    const unknown = thresholdFixed({
      id: 'promo-unknown',
      rule: { type: 'buy_x_get_y' } as never,
    });

    expect(() =>
      calculatePricing({
        lines: [line({ unitPriceCents: 120_000 })],
        context: { promotions: [unknown] },
        now: AT,
      }),
    ).toThrow(/buy_x_get_y/);
  });
});

describe('滿額折固定金額', () => {
  it('剛好達到門檻就套用', () => {
    const result = calculatePricing({
      lines: [line({ unitPriceCents: 100_000 })],
      context: { promotions: [thresholdFixed()] },
      now: AT,
    });

    expect(result.discountCents).toBe(10_000);
    expect(result.totalCents).toBe(90_000);
    expect(result.adjustments).toEqual([
      { source: 'promotion', sourceId: 'promo-1', name: '滿千折百', amountCents: -10_000 },
    ]);
    expect(result.appliedPromotions).toEqual([
      { promotionId: 'promo-1', name: '滿千折百', discountCents: 10_000 },
    ]);
  });

  it('差一分就不套用', () => {
    const result = calculatePricing({
      lines: [line({ unitPriceCents: 99_999 })],
      context: { promotions: [thresholdFixed()] },
      now: AT,
    });

    expect(result.discountCents).toBe(0);
    expect(result.totalCents).toBe(99_999);
  });

  it('遠超過門檻仍然只折固定金額一次', () => {
    const result = calculatePricing({
      lines: [line({ unitPriceCents: 100_000, quantity: 9 })],
      context: { promotions: [thresholdFixed()] },
      now: AT,
    });

    expect(result.discountCents).toBe(10_000);
    expect(result.totalCents).toBe(890_000);
  });

  it('門檻只看商品小計，不含運費與稅', () => {
    const result = calculatePricing({
      lines: [line({ unitPriceCents: 99_000 })],
      context: { promotions: [thresholdFixed()] },
      now: AT,
      shippingCents: 5_000,
      taxCents: 5_000,
    });

    expect(result.discountCents).toBe(0);
    expect(result.subtotalCents).toBe(99_000);
    expect(result.totalCents).toBe(109_000);
  });

  it('折扣不會超過商品小計', () => {
    const result = calculatePricing({
      lines: [line({ unitPriceCents: 100_000 })],
      context: {
        promotions: [
          thresholdFixed({ rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 150_000 } }),
        ],
      },
      now: AT,
    });

    expect(result.discountCents).toBe(100_000);
    expect(result.totalCents).toBe(0);
  });
});
