/**
 * 轉址目的地只接受站內路徑，避免變成開放轉址。契約上宣告的
 * `redirect({ kind: 'validated-same-origin' })` 就是這件事——唯一實作放在這裡：
 * 路由層用它清洗 outcome 的目的地，宣告頁面用它清洗要寫進表單的回程路徑。
 * 每個模組各帶一份就是等著哪個模組漏掉（ADR 0047）。
 *
 * 用 URL 解析而不是字串前綴：特殊 scheme 下反斜線等同斜線，tab / CR / LF 又會在
 * 解析前被剝掉，`/\evil.com` 與 `/<TAB>/evil.com` 都會被瀏覽器當成 protocol-relative。
 * 追這種邊角只能交給解析器。
 */
export function safeRedirectPath(value: string | undefined): string {
  if (!value) return '/';
  const cleaned = value.replace(/[\t\r\n]/g, '');
  try {
    const parsed = new URL(cleaned, 'https://internal.invalid');
    if (parsed.origin !== 'https://internal.invalid') return '/';
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return path.startsWith('/') && !path.startsWith('//') ? path : '/';
  } catch {
    return '/';
  }
}
