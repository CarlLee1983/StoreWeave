import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from '../src/safe-redirect';

/**
 * 這是全平台唯一一份開放轉址防線（ADR 0047）。它的回歸不會讓任何功能壞掉，
 * 只會讓人被送到別人的網站，所以邊角要逐一列出來。
 */
describe('轉址目的地的清洗', () => {
  it.each([
    ['/account/orders', '/account/orders'],
    ['/cart?coupon=A#top', '/cart?coupon=A#top'],
    ['/', '/'],
    // 控制字元被剝掉之後仍然是本站路徑，那就是本站路徑——危險的是剝完變成 `//` 的那種。
    ['/\tevil.example', '/evil.example'],
  ])('站內路徑原樣保留：%s', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it.each([
    ['沒有值', undefined],
    ['空字串', ''],
    ['絕對網址', 'https://evil.example/steal'],
    ['protocol-relative', '//evil.example'],
    ['反斜線（特殊 scheme 下等同斜線）', '/\\evil.example'],
    ['夾帶換行', '/\n/evil.example'],
    ['夾帶歸位', '/\r/evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['帶帳密的網址', 'https://user:pass@evil.example'],
  ])('%s 一律退回首頁', (_label, input) => {
    expect(safeRedirectPath(input as string | undefined)).toBe('/');
  });

  it('解析不出來的輸入不會拋錯，退回首頁', () => {
    expect(safeRedirectPath('http://[')).toBe('/');
  });
});
