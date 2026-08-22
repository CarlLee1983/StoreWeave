import type { ThemeContext } from '@storeweave/kernel';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatMoney(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export interface LayoutOptions {
  title: string;
  body: string;
  ctx: ThemeContext;
}

/** 結帳需要身分之後，「我是誰、怎麼登出」必須在每一頁都看得到。 */
function accountNav(ctx: ThemeContext): string {
  if (!ctx.customerName) {
    return `<a href="/login">登入</a> · <a href="/register">註冊</a>`;
  }
  return `<a href="/account/orders">我的訂單</a> · <a href="/account/profile">個人資料</a> · <span class="muted">${escapeHtml(ctx.customerName)}</span>
    <form method="post" action="/logout" class="inline">
      <button type="submit" class="linklike">登出</button>
    </form>`;
}

export function layout({ title, body, ctx }: LayoutOptions): string {
  const accent = escapeHtml(ctx.options.accentColor ?? '#111827');
  const tagline = escapeHtml(ctx.options.tagline ?? '');
  return `<!doctype html>
<html lang="${escapeHtml(ctx.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(ctx.storeName)}</title>
<style>${styles(accent)}</style>
<!--
  刻意不從第三方 CDN 載入任何 script：工單 11 之後每一頁都帶著會員 session，
  CDN 被汙染等於全站帳號接管。所有表單本來就以標準 POST 運作，不需要 JavaScript。
-->
</head>
<body>
<header class="site-header">
  <a class="brand" href="/">${escapeHtml(ctx.storeName)}</a>
  ${tagline ? `<p class="tagline">${tagline}</p>` : ''}
  <nav class="account">${accountNav(ctx)}</nav>
</header>
<main>${ctx.notice ? `<p class="notice">${escapeHtml(ctx.notice)}</p>` : ''}${body}</main>
<footer class="site-footer">
  <span>&copy; ${new Date().getFullYear()} ${escapeHtml(ctx.storeName)}</span>
  ${ctx.supportEmail ? `<a href="mailto:${escapeHtml(ctx.supportEmail)}">${escapeHtml(ctx.supportEmail)}</a>` : ''}
</footer>
</body>
</html>`;
}

function styles(accent: string): string {
  return `
:root { --accent: ${accent}; --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --card: #f9fafb; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b0f19; --fg: #e5e7eb; --muted: #9ca3af; --line: #1f2937; --card: #111827; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Noto Sans TC", sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
.site-header { border-bottom: 1px solid var(--line); padding: 20px 16px; }
.site-header .brand { font-size: 20px; font-weight: 700; text-decoration: none; color: var(--fg); }
.tagline { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
.site-footer { border-top: 1px solid var(--line); padding: 20px 16px; color: var(--muted); font-size: 14px; display: flex; gap: 16px; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
.card { border: 1px solid var(--line); border-radius: 12px; padding: 16px; background: var(--card); }
.card h2 { font-size: 16px; margin: 0 0 4px; }
.card a { color: inherit; text-decoration: none; }
.price { font-weight: 700; color: var(--accent); }
.muted { color: var(--muted); font-size: 14px; }
form { display: grid; gap: 12px; max-width: 420px; margin-top: 20px; }
label { display: grid; gap: 4px; font-size: 14px; }
input, select { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
button { padding: 10px 16px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button[disabled] { opacity: .5; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); font-size: 14px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); }
.notice { border: 1px solid var(--accent); background: var(--card); padding: 12px; border-radius: 8px; margin-bottom: 16px; }
.error { border: 1px solid #ef4444; background: rgba(239,68,68,.1); padding: 12px; border-radius: 8px; }
`;
}
