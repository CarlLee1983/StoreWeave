import { describe, expect, it } from 'vitest';
import { allocateByAmount, calculatePricing, type PricingLineInput, type Promotion } from '@storeweave/promotion';

const AT = new Date('2026-08-22T00:00:00.000Z');

function line(lineId: string, unitPriceCents: number, quantity = 1): PricingLineInput {
  return { lineId, productId: `product-${lineId}`, unitPriceCents, quantity };
}

function promo(id: string, rule: Promotion['rule'], priority = 0): Promotion {
  return { id, name: id, priority, stackable: true, startsAt: null, endsAt: null, rule };
}

describe('allocateByAmount', () => {
  it('整除時按比例分攤', () => {
    expect(allocateByAmount([600, 400], 100)).toEqual([60, 40]);
  });

  it('餘數給金額最高的那一行', () => {
    // 101 攤到 1000 的三行：30.3 / 50.5 / 20.2 → 無條件捨去後餘 1，給最高的 500
    expect(allocateByAmount([300, 500, 200], 101)).toEqual([30, 51, 20]);
  });

  it('金額相同時餘數給排序在前的那一行', () => {
    expect(allocateByAmount([100, 100, 100], 100)).toEqual([34, 33, 33]);
  });

  it('餘數大於一分時整批給同一行', () => {
    // 剛好整除，沒有餘數可分
    expect(allocateByAmount([100, 700, 100, 100], 10)).toEqual([1, 7, 1, 1]);
    const shares = allocateByAmount([333, 333, 333, 1], 10);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10);
    expect(shares).toEqual([4, 3, 3, 0]);
  });

  it('分攤總和永遠等於要分攤的金額', () => {
    for (let amount = 0; amount <= 200; amount += 7) {
      const shares = allocateByAmount([997, 3, 111, 1_000_001], amount);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
    }
  });

  it('沒有一行分到超過自己的金額，超出的部分往下一行溢', () => {
    // 全額折抵：每一行都剛好被折光
    expect(allocateByAmount([10, 1], 11)).toEqual([10, 1]);
    // 餘數若會讓拿到它的那一行變負數，溢給下一行
    expect(allocateByAmount([3, 3], 5)).toEqual([3, 2]);
    expect(allocateByAmount([5, 5, 1], 10)).toEqual([5, 5, 0]);
  });

  it('同樣的輸入永遠得到同樣的結果', () => {
    const amounts = [1_234, 5_678, 91, 1_234];
    expect(allocateByAmount(amounts, 777)).toEqual(allocateByAmount(amounts, 777));
  });

  it('金額為零的商品行不分到折扣', () => {
    expect(allocateByAmount([0, 100], 10)).toEqual([0, 10]);
  });

  it('全部商品行都是零元時不分攤', () => {
    expect(allocateByAmount([0, 0], 10)).toEqual([0, 0]);
  });
});

describe('引擎輸出的商品行', () => {
  it('沒有折扣時每一行的實收就是自己的金額', () => {
    const result = calculatePricing({
      lines: [line('a', 30_000, 2), line('b', 10_000)],
      context: { promotions: [] },
      now: AT,
    });

    expect(result.lines).toEqual([
      { lineId: 'a', lineTotalCents: 60_000, discountCents: 0, netCents: 60_000, adjustments: [] },
      { lineId: 'b', lineTotalCents: 10_000, discountCents: 0, netCents: 10_000, adjustments: [] },
    ]);
  });

  it('訂單層折扣攤回每一行，每一行知道自己被哪個活動折了多少', () => {
    const result = calculatePricing({
      lines: [line('a', 60_000), line('b', 40_000)],
      context: {
        promotions: [promo('fixed', { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 })],
      },
      now: AT,
    });

    expect(result.lines).toEqual([
      {
        lineId: 'a',
        lineTotalCents: 60_000,
        discountCents: 6_000,
        netCents: 54_000,
        adjustments: [{ source: 'promotion', sourceId: 'fixed', name: 'fixed', amountCents: -6_000 }],
      },
      {
        lineId: 'b',
        lineTotalCents: 40_000,
        discountCents: 4_000,
        netCents: 36_000,
        adjustments: [{ source: 'promotion', sourceId: 'fixed', name: 'fixed', amountCents: -4_000 }],
      },
    ]);
  });

  it('多個活動各自分攤，行的折扣合計等於訂單折扣', () => {
    const result = calculatePricing({
      lines: [line('a', 33_333), line('b', 33_333), line('c', 33_334)],
      context: {
        promotions: [
          promo('fixed', { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 9_999 }, 10),
          promo('pct', { type: 'order_percentage', percentOffBasisPoints: 777 }, 20),
        ],
      },
      now: AT,
    });

    const lineDiscountTotal = result.lines.reduce((sum, l) => sum + l.discountCents, 0);
    expect(lineDiscountTotal).toBe(result.discountCents);
    for (const l of result.lines) {
      expect(l.adjustments).toHaveLength(2);
      expect(l.netCents).toBeGreaterThanOrEqual(0);
      expect(l.discountCents + l.netCents).toBe(l.lineTotalCents);
    }
    expect(result.lines.reduce((sum, l) => sum + l.netCents, 0)).toBe(result.totalCents);
  });

  it('折扣吃掉整張單時每一行的實收是零而不是負數', () => {
    const result = calculatePricing({
      lines: [line('a', 7), line('b', 3), line('c', 1)],
      context: {
        promotions: [promo('all', { type: 'order_percentage', percentOffBasisPoints: 10_000 })],
      },
      now: AT,
    });

    expect(result.discountCents).toBe(11);
    expect(result.totalCents).toBe(0);
    expect(result.lines.map((l) => l.netCents)).toEqual([0, 0, 0]);
  });
});
