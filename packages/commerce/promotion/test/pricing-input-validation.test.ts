import { describe, expect, it } from 'vitest';
import { calculatePricing, allocateByAmount, type Promotion } from '@storeweave/promotion';

const AT = new Date('2026-08-22T00:00:00.000Z');

function promo(rule: Promotion['rule']): Promotion {
  return { id: 'p', name: 'p', priority: 0, stackable: true, startsAt: null, endsAt: null, rule };
}

const price = (unitPriceCents: number, quantity = 1) => ({
  lineId: 'line-1',
  productId: 'product-1',
  unitPriceCents,
  quantity,
});

const halfOff = promo({ type: 'order_percentage', percentOffBasisPoints: 5_000 });

describe('引擎擋掉算不出正確金額的輸入', () => {
  it('負數的單價被擋下來', () => {
    expect(() =>
      calculatePricing({ lines: [price(1_000), price(-300)], context: { promotions: [halfOff] }, now: AT }),
    ).toThrow(/unitPriceCents/);
  });

  it('負數的數量被擋下來', () => {
    expect(() =>
      calculatePricing({ lines: [price(1_000), price(300, -1)], context: { promotions: [halfOff] }, now: AT }),
    ).toThrow(/quantity/);
  });

  it('非整數分被擋下來', () => {
    expect(() =>
      calculatePricing({ lines: [price(10.5, 3)], context: { promotions: [] }, now: AT }),
    ).toThrow(/unitPriceCents/);
  });

  it('缺欄位的規則不會靜默算成 NaN', () => {
    const broken = promo({ type: 'order_percentage', percentOffBasisPoints: undefined as never });
    expect(() =>
      calculatePricing({ lines: [price(100_000)], context: { promotions: [broken] }, now: AT }),
    ).toThrow(/order_percentage/);
  });

  it('引擎不認得的規則型別會出聲，而不是讓顧客少折錢', () => {
    const unknown = promo({ type: 'buy_x_get_y' } as never);
    expect(() =>
      calculatePricing({ lines: [price(100_000)], context: { promotions: [unknown] }, now: AT }),
    ).toThrow(/buy_x_get_y/);
  });
});

describe('分攤的不變式', () => {
  it('分攤不下的金額會出聲，而不是回傳一筆對不起來的帳', () => {
    expect(() => allocateByAmount([100, 100], 250)).toThrow(/allocate/i);
  });

  it('容量陣列長度不符會出聲', () => {
    expect(() => allocateByAmount([100, 200, 300], 60, [100])).toThrow(/length/i);
  });

  it('餘數大於一分時整批給金額最高的那一行', () => {
    // 各行 floor 後合計 91，餘 9 全部給 1_000 那一行
    const shares = allocateByAmount([1, 1, 1, 1, 1, 1, 1, 1, 1, 1_000], 100);
    expect(shares).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 100]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('多個活動疊加後仍然對得起來', () => {
  it('前一個活動把某一行折光後，後一個活動的分攤仍不讓任何一行變負數', () => {
    const result = calculatePricing({
      lines: [
        { lineId: 'a', productId: 'p-a', unitPriceCents: 100, quantity: 1 },
        { lineId: 'b', productId: 'p-b', unitPriceCents: 1, quantity: 1 },
      ],
      context: {
        promotions: [
          { ...promo({ type: 'order_percentage', percentOffBasisPoints: 9_000 }), id: 'first', priority: 10 },
          { ...promo({ type: 'order_percentage', percentOffBasisPoints: 10_000 }), id: 'second', priority: 20 },
        ],
      },
      now: AT,
    });

    expect(result.discountCents).toBe(101);
    expect(result.totalCents).toBe(0);
    expect(result.lines.map((l) => l.netCents)).toEqual([0, 0]);
    expect(result.lines.reduce((sum, l) => sum + l.discountCents, 0)).toBe(result.discountCents);
  });
});

describe('優先序相同時的順序', () => {
  it('依活動 id 決定，與輸入陣列的排列無關', () => {
    const a: Promotion = { ...promo({ type: 'order_percentage', percentOffBasisPoints: 1_000 }), id: 'a', priority: 10 };
    const b: Promotion = { ...promo({ type: 'order_percentage', percentOffBasisPoints: 1_000 }), id: 'b', priority: 10 };

    const forward = calculatePricing({ lines: [price(100_000)], context: { promotions: [b, a] }, now: AT });
    const reversed = calculatePricing({ lines: [price(100_000)], context: { promotions: [a, b] }, now: AT });

    expect(forward.appliedPromotions.map((p) => p.promotionId)).toEqual(['a', 'b']);
    expect(reversed.appliedPromotions.map((p) => p.promotionId)).toEqual(['a', 'b']);
  });
});
