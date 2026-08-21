import { describe, expect, it } from 'vitest';
import { promotionRule, createPromotionInput, type Promotion } from '@storeweave/promotion';

describe('促銷規則的參數驗證', () => {
  it('滿額折固定金額：門檻與折抵金額都要是非負整數分，折抵不得為零', () => {
    expect(promotionRule.safeParse({ type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 }).success).toBe(true);
    expect(promotionRule.safeParse({ type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 0 }).success).toBe(false);
    expect(promotionRule.safeParse({ type: 'threshold_fixed_amount', thresholdCents: -1, discountCents: 10 }).success).toBe(false);
    expect(promotionRule.safeParse({ type: 'threshold_fixed_amount', thresholdCents: 10.5, discountCents: 10 }).success).toBe(false);
  });

  it('百分比：基點介於 1 與 10000 之間', () => {
    expect(promotionRule.safeParse({ type: 'order_percentage', percentOffBasisPoints: 1 }).success).toBe(true);
    expect(promotionRule.safeParse({ type: 'order_percentage', percentOffBasisPoints: 10_000 }).success).toBe(true);
    expect(promotionRule.safeParse({ type: 'order_percentage', percentOffBasisPoints: 0 }).success).toBe(false);
    expect(promotionRule.safeParse({ type: 'order_percentage', percentOffBasisPoints: 10_001 }).success).toBe(false);
  });

  it('少填必要參數時錯誤訊息指得出是哪一個欄位', () => {
    const result = promotionRule.safeParse({ type: 'threshold_percentage', thresholdCents: 100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('percentOffBasisPoints');
    }
  });

  it('不認得的規則型別被拒絕', () => {
    expect(promotionRule.safeParse({ type: 'buy_x_get_y', quantity: 2 }).success).toBe(false);
  });

  it('驗過的規則就是定價引擎吃的那一種規則', () => {
    const parsed = promotionRule.parse({ type: 'order_percentage', percentOffBasisPoints: 500 });
    const rule: Promotion['rule'] = parsed;
    expect(rule.type).toBe('order_percentage');
  });
});

describe('建立促銷活動的輸入', () => {
  const base = {
    name: '滿千折百',
    rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
  };

  it('優先序與可否疊加有預設值，是活動本身的屬性', () => {
    const parsed = createPromotionInput.parse(base);
    expect(parsed.priority).toBe(0);
    expect(parsed.stackable).toBe(true);
    expect(parsed.status).toBe('active');
  });

  it('結束時間不得早於或等於開始時間', () => {
    const bad = createPromotionInput.safeParse({
      ...base,
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-09-01T00:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  it('只設開始或只設結束都可以', () => {
    expect(createPromotionInput.safeParse({ ...base, startsAt: '2026-09-01T00:00:00.000Z' }).success).toBe(true);
    expect(createPromotionInput.safeParse({ ...base, endsAt: '2026-09-01T00:00:00.000Z' }).success).toBe(true);
  });
});
