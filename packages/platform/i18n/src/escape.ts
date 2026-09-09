/**
 * HTML 文字節點與屬性值的跳脫。
 *
 * 住在共用套件而不是 theme：mail 模板同樣需要它，而 mail 不能 import theme。
 * `&` 必須先換，否則後面產生的 entity 會被二次跳脫。
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
