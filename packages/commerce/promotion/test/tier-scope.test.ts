import { describe, expect, it } from 'vitest';
import { calculatePricing, type Promotion, type PricingLineInput } from '@storeweave/promotion';

/** 等級限定的活動（工單 45）。等級只是定價的一個輸入變數。 */

const AT = new Date('2026-08-22T00:00:00.000Z');
const line: PricingLineInput = { lineId: 'l1', productId: 'p1', unitPriceCents: 10_000, quantity: 1 };

function promotion(tierNames?: string[]): Promotion {
  return {
    id: 'promo-1', name: '金卡九折', priority: 0, stackable: true, startsAt: null, endsAt: null,
    tierNames,
    rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
  };
}

const priceFor = (membershipTier: string | null, tierNames?: string[]) =>
  calculatePricing({ lines: [line], context: { promotions: [promotion(tierNames)], membershipTier }, now: AT });

describe('等級限定', () => {
  it('沒有指定等級的活動人人適用', () => {
    expect(priceFor(null).discountCents).toBe(1_000);
    expect(priceFor('金卡').discountCents).toBe(1_000);
  });

  it('空陣列與未指定一樣，都是人人適用', () => {
    expect(priceFor(null, []).discountCents).toBe(1_000);
  });

  it('名單上的等級才套用', () => {
    expect(priceFor('金卡', ['金卡']).discountCents).toBe(1_000);
    expect(priceFor('銀卡', ['金卡']).discountCents).toBe(0);
  });

  it('沒有等級的人不符合任何等級限定的活動', () => {
    expect(priceFor(null, ['金卡']).discountCents).toBe(0);
  });

  it('可以同時指定多個等級', () => {
    expect(priceFor('銀卡', ['銀卡', '金卡']).discountCents).toBe(1_000);
  });

  it('套不到的門檻活動不會出現在「還差多少」裡——那只是讓顧客白跑一趟', () => {
    const gold: Promotion = {
      ...promotion(['金卡']),
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    };
    const result = calculatePricing({
      lines: [line],
      context: { promotions: [gold], membershipTier: '銀卡' },
      now: AT,
    });

    expect(result.nextThreshold).toBeNull();
  });
});
