import { describe, expect, it } from 'vitest';
import { COUPON_CODE_ALPHABET, GENERATED_CODE_LENGTH, generateCouponCode } from '@storeweave/coupon';

/** 系統產生的券碼（工單 33）。 */

describe('券碼產生', () => {
  it('至少十二個字元，而且只用不易混淆的字母集', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCouponCode();
      const body = code.replace(/-/g, '');
      expect(body).toHaveLength(GENERATED_CODE_LENGTH);
      expect(GENERATED_CODE_LENGTH).toBeGreaterThanOrEqual(12);
      expect(body.split('').every((c) => COUPON_CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('排除掉的正是那些會被看錯的字元', () => {
    for (const confusable of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(COUPON_CODE_ALPHABET).not.toContain(confusable);
    }
  });

  it('前綴會被保留並轉成大寫，方便一眼認出是哪一批', () => {
    expect(generateCouponCode('spring')).toMatch(/^SPRING-/);
  });

  it('不會撞碼：兩千次產生沒有重複', () => {
    const seen = new Set(Array.from({ length: 2_000 }, () => generateCouponCode()));
    expect(seen.size).toBe(2_000);
  });
});
