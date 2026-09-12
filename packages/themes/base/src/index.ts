import { z } from 'zod';
import { escapeHtml } from '@storeweave/i18n';
import { defineTheme, type ThemeContext, type ThemeNavigationItem } from '@storeweave/kernel';
import type {
  AuthPages, ThemeForgotPasswordView, ThemeLoginView, ThemeRegisterView, ThemeResetPasswordView,
} from '@storeweave/auth';
import type { SitePages } from '@storeweave/site';
import type { ContentPages, ThemeArticleListView, ThemeArticleView, ThemeContactView } from '@storeweave/content';

/**
 * Base Theme：只實作通用頁，完全不認得任何商務概念（ADR 0045）。
 * 它存在的理由是證明一個沒有商務模組的 release 也渲染得出可瀏覽的網站——
 * 導覽與標語都來自資料，這個檔案裡沒有一條寫死的連結（ADR 0046）。
 */
export const baseThemeOptions = z.object({
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2F5D62'),
});

/**
 * The second base theme deliberately uses the same page contract and data
 * projections as Base Site.  Only visual options belong to a theme; site
 * settings, navigation, content and media stay in their existing tables
 * when an operator switches between these ids (ADR 0045/0046).
 */
export const editorialThemeOptions = z.object({
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8C3E28'),
});

function links(items: readonly ThemeNavigationItem[]): string {
  return items.map(item => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`).join('');
}

function layout(ctx: ThemeContext, title: string, body: string, seo: { description?: string; canonicalPath?: string } = {}): string {
  const accent = escapeHtml((ctx.options.accentColor as string | undefined) ?? '#2F5D62');
  const tagline = ctx.tagline ? escapeHtml(ctx.tagline) : '';
  const footerNote = ctx.footerNote ? escapeHtml(ctx.footerNote) : '';
  return `<!doctype html>
<html lang="${escapeHtml(ctx.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(ctx.storeName)}</title>
${seo.description ? `<meta name="description" content="${escapeHtml(seo.description)}">` : ''}
${seo.canonicalPath ? `<link rel="canonical" href="${escapeHtml(new URL(seo.canonicalPath, ctx.publicUrl).toString())}">` : ''}
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
input, textarea { width: 100%; padding: .55rem .7rem; border: 1px solid var(--line); border-radius: .4rem; font: inherit; }
textarea { min-height: 9rem; resize: vertical; }
button { margin-top: 1rem; padding: .6rem 1.2rem; border: 0; border-radius: .4rem; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.error { color: #a12d2d; font-weight: 600; }
.contact-hp { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
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

function articleBody(article: ThemeArticleView): string {
  return article.body.map(block => `${block.heading ? `<h2>${escapeHtml(block.heading)}</h2>` : ''}<p>${escapeHtml(block.text)}</p>`).join('');
}

/** B10 previews stay private unless Content has proved a published reference. */
function articleImage(article: ThemeArticleView): string {
  return article.mediaAssetId ? `<img src="/content/media/${escapeHtml(article.mediaAssetId)}/preview" alt="${escapeHtml(article.summary || article.title)}" loading="lazy">` : '';
}

function canonicalArticlePath(article: ThemeArticleView): string {
  if (article.kind === 'story') return '/story';
  return `/${article.kind}/${encodeURIComponent(article.slug)}`;
}

function renderArticle(ctx: ThemeContext, article: ThemeArticleView): string {
  return layout(ctx, article.title, `<article>
    ${article.section ? `<p>${escapeHtml(article.section)}</p>` : ''}
    <h1>${escapeHtml(article.title)}</h1>
    ${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ''}${articleImage(article)}
    ${articleBody(article)}
  </article>`, { description: article.summary || article.title, canonicalPath: canonicalArticlePath(article) });
}

function renderArticleList(ctx: ThemeContext, view: ThemeArticleListView): string {
  const labels: Record<ThemeArticleListView['kind'], string> = {
    story: '品牌故事', journal: '生活誌', news: '最新消息', faq: '常見問題',
  };
  const basePath: Record<ThemeArticleListView['kind'], string> = {
    story: '/story', journal: '/journal', news: '/news', faq: '/faq',
  };
  const body = view.articles.map(article => {
    if (view.kind === 'faq') return `<article><h2>${escapeHtml(article.title)}</h2>${articleBody(article)}</article>`;
    const href = view.kind === 'story' ? basePath.story : `${basePath[view.kind]}/${encodeURIComponent(article.slug)}`;
    return `<article>${articleImage(article)}<h2><a href="${href}">${escapeHtml(article.title)}</a></h2>${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ''}</article>`;
  }).join('');
  const page = view.pagination;
  const controls = !page || page.total <= page.pageSize ? '' : `<nav aria-label="內容分頁">${page.page > 1 ? `<a href="${page.basePath}?page=${page.page - 1}" rel="prev">上一頁</a>` : ''} 第 ${page.page} 頁 ${page.page * page.pageSize < page.total ? `<a href="${page.basePath}?page=${page.page + 1}" rel="next">下一頁</a>` : ''}</nav>`;
  const pageSuffix = view.pagination && view.pagination.page > 1 ? `?page=${view.pagination.page}` : '';
  return layout(ctx, labels[view.kind], `<h1>${labels[view.kind]}</h1>${body}${controls}`, { description: `${labels[view.kind]}文章與資訊`, canonicalPath: `${view.pagination?.basePath ?? basePath[view.kind]}${pageSuffix}` });
}

function renderContact(ctx: ThemeContext, view: ThemeContactView): string {
  if (view.submitted) return layout(ctx, '聯絡我們', '<h1>聯絡我們</h1><p role="status">訊息已送出，我們會盡快回覆。</p>', { canonicalPath: '/contact' });
  const csrf = ctx.csrfToken ? `<input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrfToken)}">` : '';
  const value = (name: keyof ThemeContactView['values']) => escapeHtml(view.values[name]);
  return layout(ctx, '聯絡我們', `<h1>聯絡我們</h1>
    ${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ''}
    <form method="post" action="/contact">
      ${csrf}<label for="name">姓名</label><input id="name" name="name" value="${value('name')}" required>
      <label for="email">電子郵件</label><input id="email" name="email" type="email" value="${value('email')}" required>
      <label for="subject">主旨</label><input id="subject" name="subject" value="${value('subject')}" required>
      <label for="message">訊息</label><textarea id="message" name="message" required>${value('message')}</textarea>
      <label class="contact-hp" aria-hidden="true">請不要填寫<input name="website" tabindex="-1" autocomplete="off"></label>
      <button type="submit">送出訊息</button>
    </form>`, { canonicalPath: '/contact' });
}

/**
 * 設定新密碼時的前端下限，與 Default Theme 同一個數字。真正的政策在後端，
 * 這裡只是讓人不必送出才知道太短。
 */
const PASSWORD_MIN_LENGTH = 8;

/**
 * 四種認證版型共用的骨架。四個 view 型別各自獨立（ADR 0047），但版面差異只有
 * 標題與哪幾個欄位要出現，所以這裡收一份參數化的表單，四個 renderer 各自把
 * 自己的欄位填進來——複製四份 HTML 只會讓其中一份先長歪。
 */
interface AuthForm {
  readonly mode: 'login' | 'register' | 'forgot-password' | 'reset-password';
  readonly title: string;
  readonly next: string;
  readonly error?: string;
  readonly notice?: string;
  readonly token?: string;
  /** 沒有這個 key 就是這一頁沒有信箱欄位；`value` 是預填值，空字串代表欄位留空。 */
  readonly emailField?: { readonly value: string };
  readonly passwordField?: {
    readonly autocomplete: 'current-password' | 'new-password';
    /** 設定新密碼的兩頁才有下限；登入不設，舊密碼比現行政策短的人照樣登得進來。 */
    readonly minLength?: number;
  };
}

function renderAuthForm(ctx: ThemeContext, form: AuthForm): string {
  const csrf = ctx.csrfToken ? `<input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrfToken)}">` : '';
  const next = `<input type="hidden" name="next" value="${escapeHtml(form.next)}">`;
  const email = form.emailField === undefined ? '' : `<label for="email">電子郵件</label>
      <input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(form.emailField.value)}" required>`;
  const minLength = form.passwordField?.minLength;
  const password = form.passwordField === undefined ? '' : `<label for="password">密碼</label>
      <input id="password" name="password" type="password" autocomplete="${form.passwordField.autocomplete}"${
        minLength === undefined ? '' : ` minlength="${minLength}"`} required>`;
  const token = form.token === undefined
    ? '' : `<input type="hidden" name="token" value="${escapeHtml(form.token)}">`;
  const notice = form.notice ? `<p class="notice" role="status">${escapeHtml(form.notice)}</p>` : '';
  return layout(ctx, form.title, `
    <h1>${form.title}</h1>
    ${form.error ? `<p class="error" role="alert">${escapeHtml(form.error)}</p>` : ''}
    ${notice}
    <form method="post" action="/${form.mode}">
      ${csrf}${next}${token}
      ${email}
      ${password}
      <button type="submit">${form.title}</button>
    </form>
  `);
}

function renderLogin(ctx: ThemeContext, view: ThemeLoginView): string {
  return renderAuthForm(ctx, {
    mode: 'login', title: '登入', next: view.next, error: view.error,
    emailField: { value: view.email ?? '' }, passwordField: { autocomplete: 'current-password' },
  });
}

function renderRegister(ctx: ThemeContext, view: ThemeRegisterView): string {
  return renderAuthForm(ctx, {
    mode: 'register', title: '註冊', next: view.next, error: view.error,
    emailField: { value: '' },
    passwordField: { autocomplete: 'new-password', minLength: PASSWORD_MIN_LENGTH },
  });
}

function renderForgotPassword(ctx: ThemeContext, view: ThemeForgotPasswordView): string {
  return renderAuthForm(ctx, {
    mode: 'forgot-password', title: '忘記密碼', next: view.next, notice: view.notice,
    emailField: { value: '' },
  });
}

function renderResetPassword(ctx: ThemeContext, view: ThemeResetPasswordView): string {
  return renderAuthForm(ctx, {
    mode: 'reset-password', title: '重設密碼', next: view.next, error: view.error,
    token: view.token,
    passwordField: { autocomplete: 'new-password', minLength: PASSWORD_MIN_LENGTH },
  });
}

function renderError(ctx: ThemeContext, view: { status: number; message: string }): string {
  return layout(ctx, `${view.status}`, `
    <h1>${view.status}</h1>
    <p>${escapeHtml(view.message)}</p>
    <p><a href="/">回到首頁</a></p>
  `);
}

type BasePages = SitePages & AuthPages & ContentPages;

export const baseTheme = defineTheme<BasePages>({
  id: 'base',
  name: 'Base Site',
  optionsSchema: baseThemeOptions,
  renderers: {
    'platform.site.home': renderHome,
    // 每一組認證頁的顯示與送出共用同一個渲染函式：送出失敗時要重新渲染的就是同一張表單。
    'platform.auth.login': renderLogin,
    'platform.auth.submitLogin': renderLogin,
    'platform.auth.register': renderRegister,
    'platform.auth.submitRegister': renderRegister,
    'platform.auth.forgotPassword': renderForgotPassword,
    'platform.auth.submitForgotPassword': renderForgotPassword,
    'platform.auth.resetPassword': renderResetPassword,
    'platform.auth.submitResetPassword': renderResetPassword,
    'commerce.content.story': (ctx, view) => renderArticle(ctx, view.article),
    'commerce.content.journalList': renderArticleList,
    'commerce.content.journalArticle': (ctx, view) => renderArticle(ctx, view.article),
    'commerce.content.newsList': renderArticleList,
    'commerce.content.newsArticle': (ctx, view) => renderArticle(ctx, view.article),
    'commerce.content.faq': renderArticleList,
    'commerce.content.contact': renderContact,
    'commerce.content.submitContact': renderContact,
    'platform.error': renderError,
  },
});

/** A compatible, independently selectable visual treatment for base sites. */
export const editorialTheme = defineTheme<BasePages>({
  id: 'editorial',
  name: 'Editorial Site',
  optionsSchema: editorialThemeOptions,
  renderers: { ...baseTheme.renderers, 'platform.error': baseTheme.renderers['platform.error'] },
});

/**
 * 版面外框。模組替自己的頁面寫 renderer 時用它，頁面才會和 base Theme 其他頁同一個外框：
 * 導覽、標語與頁尾仍然只來自資料（ADR 0046）。
 */
export { layout as renderBaseLayout };

export default baseTheme;
