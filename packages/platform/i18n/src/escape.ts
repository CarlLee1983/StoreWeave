/**
 * HTML 文字節點與一般屬性值的跳脫。
 *
 * 住在共用套件而不是 theme：mail 模板同樣需要它，而 mail 不能 import theme。
 * `&` 必須先換，否則後面產生的 entity 會被二次跳脫。
 *
 * **不適用於** URL 屬性（`href`／`src`）、`<script>`、`<style>` 與事件屬性：
 * `javascript:alert(1)` 完整通過這五個替換。URL 屬性請用 `safeUrlAttribute`。
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `href`／`src` 允許的協定。其餘一律視為不可信。 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * 把值當成 URL 屬性輸出。
 *
 * `escapeHtml` 擋不住 `javascript:` 與 `data:`——那些字元一個都不需要跳脫就能執行。
 * 不被接受的值回傳空字串，讓連結失效而不是變成注入點。
 */
export function safeUrlAttribute(value: unknown, base = 'https://invalid.example'): string {
  const raw = String(value ?? '').trim();
  if (raw === '') return '';
  try {
    const url = new URL(raw, base);
    if (!SAFE_URL_SCHEMES.has(url.protocol)) return '';
  } catch {
    return '';
  }
  return escapeHtml(raw);
}
