import { z } from 'zod';
import { escapeHtml } from '@storeweave/i18n';
import { defineTheme, type ThemeAuthView, type ThemeContext, type ThemeNavigationItem } from '@storeweave/kernel';
import type { AuthPages } from '@storeweave/auth';
import type { SitePages } from '@storeweave/site';

/**
 * Base Theme：只實作通用頁，完全不認得任何商務概念（ADR 0045）。
 * 它存在的理由是證明一個沒有商務模組的 release 也渲染得出可瀏覽的網站——
 * 導覽與標語都來自資料，這個檔案裡沒有一條寫死的連結（ADR 0046）。
 */
export const baseThemeOptions = z.object({
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2F5D62'),
});

function links(items: readonly ThemeNavigationItem[]): string {
  return items.map(item => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`).join('');
}

function layout(ctx: ThemeContext, title: string, body: string): string {
  const accent = escapeHtml((ctx.options.accentColor as string | undefined) ?? '#2F5D62');
  const tagline = ctx.tagline ? escapeHtml(ctx.tagline) : '';
  const footerNote = ctx.footerNote ? escapeHtml(ctx.footerNote) : '';
  return `<!doctype html>
<html lang="${escapeHtml(ctx.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(ctx.storeName)}</title>
<style>${styles(accent)}</style>
</head>
<body>
<a class="skip-link" href="#main-content">跳至主要內容</a>
<header class="site-header">
  <a class="brand" href="/">${escapeHtml(ctx.storeName)}</a>
  ${tagline ? `<p class="tagline">${tagline}</p>` : ''}
  <nav class="site-nav" aria-label="主要導覽">${links(ctx.navigation?.primary ?? [])}</nav>
</header>
<main id="main-content" tabindex="-1">${ctx.notice ? `<p class="notice" role="status">${escapeHtml(ctx.notice)}</p>` : ''}${body}</main>
<footer class="site-footer">
  <nav class="footer-nav" aria-label="頁尾導覽">${links(ctx.navigation?.footer ?? [])}</nav>
  ${footerNote ? `<p>${footerNote}</p>` : ''}
  ${ctx.supportEmail ? `<p><a href="mailto:${escapeHtml(ctx.supportEmail)}">${escapeHtml(ctx.supportEmail)}</a></p>` : ''}
  <p>&copy; ${new Date().getFullYear()} ${escapeHtml(ctx.storeName)}</p>
</footer>
</body>
</html>`;
}

function styles(accent: string): string {
  return `
:root { --accent: ${accent}; --ink: #23282b; --muted: #5d6a70; --line: #dfe4e6; --canvas: #fbfbfa; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--ink); font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif; line-height: 1.65; }
.skip-link { position: absolute; left: -9999px; }
.skip-link:focus { left: 1rem; top: 1rem; background: #fff; padding: .5rem 1rem; z-index: 10; }
.site-header, main, .site-footer { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem; }
.site-header { border-bottom: 1px solid var(--line); }
.brand { font-size: 1.35rem; font-weight: 700; color: var(--ink); text-decoration: none; }
.tagline { margin: .25rem 0 0; color: var(--muted); font-size: .9rem; }
.site-nav, .footer-nav { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: .9rem; }
.site-nav a, .footer-nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
.site-nav a:hover, .footer-nav a:hover { text-decoration: underline; }
.site-footer { border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
.notice { background: #fff5d8; border: 1px solid #e6d089; padding: .75rem 1rem; border-radius: .5rem; }
h1 { font-size: 1.8rem; margin: 0 0 .5rem; }
label { display: block; margin: .75rem 0 .25rem; font-weight: 600; }
input { width: 100%; padding: .55rem .7rem; border: 1px solid var(--line); border-radius: .4rem; font: inherit; }
button { margin-top: 1rem; padding: .6rem 1.2rem; border: 0; border-radius: .4rem; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.error { color: #a12d2d; font-weight: 600; }
`;
}

/**
 * 首頁沒有自己的資料：標語與導覽都是網站外框，由 ThemeContext 帶進來。
 * 一個 base-only 的網站要放什麼內容，是網站設定與往後的頁面模組的事。
 */
function renderHome(ctx: ThemeContext): string {
  return layout(ctx, ctx.storeName, `
    <h1>${escapeHtml(ctx.storeName)}</h1>
    ${ctx.tagline ? `<p>${escapeHtml(ctx.tagline)}</p>` : ''}
  `);
}

const AUTH_TITLES: Record<ThemeAuthView['mode'], string> = {
  'login': '登入',
  'register': '註冊',
  'forgot-password': '忘記密碼',
  'reset-password': '重設密碼',
};

function renderAuth(ctx: ThemeContext, view: ThemeAuthView): string {
  const title = AUTH_TITLES[view.mode];
  const csrf = ctx.csrfToken ? `<input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrfToken)}">` : '';
  const next = `<input type="hidden" name="next" value="${escapeHtml(view.next)}">`;
  const email = view.mode === 'reset-password' ? '' : `<label for="email">電子郵件</label>
      <input id="email" name="email" type="email" autocomplete="email" required>`;
  const passwordAutocomplete = view.mode === 'reset-password' ? 'new-password' : 'current-password';
  const password = view.mode === 'forgot-password' ? '' : `<label for="password">密碼</label>
      <input id="password" name="password" type="password" autocomplete="${passwordAutocomplete}" required>`;
  const token = view.mode === 'reset-password'
    ? `<input type="hidden" name="token" value="${escapeHtml(view.token)}">` : '';
  const notice = view.mode === 'forgot-password' && view.notice
    ? `<p class="notice" role="status">${escapeHtml(view.notice)}</p>` : '';
  return layout(ctx, title, `
    <h1>${title}</h1>
    ${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ''}
    ${notice}
    <form method="post" action="/${view.mode}">
      ${csrf}${next}${token}
      ${email}
      ${password}
      <button type="submit">${title}</button>
    </form>
  `);
}

function renderError(ctx: ThemeContext, view: { status: number; message: string }): string {
  return layout(ctx, `${view.status}`, `
    <h1>${view.status}</h1>
    <p>${escapeHtml(view.message)}</p>
    <p><a href="/">回到首頁</a></p>
  `);
}

export const baseTheme = defineTheme<SitePages & AuthPages>({
  id: 'base',
  name: 'Base Site',
  optionsSchema: baseThemeOptions,
  renderers: {
    'platform.site.home': renderHome,
    'platform.auth.login': renderAuth,
    'platform.auth.submitLogin': renderAuth,
    'platform.auth.register': renderAuth,
    'platform.auth.submitRegister': renderAuth,
    'platform.auth.forgotPassword': renderAuth,
    'platform.auth.submitForgotPassword': renderAuth,
    'platform.auth.resetPassword': renderAuth,
    'platform.auth.submitResetPassword': renderAuth,
    'platform.auth': renderAuth,
    'platform.error': renderError,
  },
});

export default baseTheme;
