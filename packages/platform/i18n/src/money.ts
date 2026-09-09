import { escapeHtml } from './escape';

/**
 * 以最小單位（cents）輸入，輸出該語系的貨幣寫法。
 *
 * Intl 對未知幣別或語系標籤會丟例外，此時退回固定兩位小數的純文字並跳脫——
 * 金額顯示不該因為設定打錯就讓整頁掛掉。
 */
export function formatMoney(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    // 只跳脫 currency：它來自設定，會被插進 HTML；數字本身不含危險字元。
    return `${(cents / 100).toFixed(2)} ${escapeHtml(currency)}`;
  }
}
