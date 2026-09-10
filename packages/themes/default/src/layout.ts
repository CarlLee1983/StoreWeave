import type { ThemeContext, ThemeNavigationItem } from '@storeweave/kernel';
import { escapeHtml } from '@storeweave/i18n';

/**
 * Google Fonts 的樣式表位址。字重範圍要與 `--font-sans` 的用法一致：
 * 400 內文、500/600 強調、700 標題。
 */
export const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400..700&display=swap';

export { escapeHtml, formatMoney } from '@storeweave/i18n';

export interface LayoutOptions {
  title: string;
  body: string;
  ctx: ThemeContext;
}

/** 結帳需要身分之後，「我是誰、怎麼登出」必須在每一頁都看得到。 */
function accountNav(ctx: ThemeContext): string {
  if (!ctx.customerName) {
    return '<a href="/login">登入</a><a href="/register">註冊</a>';
  }
  return `<a href="/account/orders">會員中心</a><span class="account__name">${escapeHtml(ctx.customerName)}</span>
    <form method="post" action="/logout" class="inline">
      <button type="submit" class="linklike">登出</button>
    </form>`;
}

/** 一組導覽項目的連結。內容全部來自資料，Theme 只負責排版（ADR 0046）。 */
function links(items: readonly ThemeNavigationItem[]): string {
  return items.map(item => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`).join('');
}

/** 頁尾依 `group` 分欄，順序就是導覽資料的順序；沒有分組的項目歸到最後一欄。 */
function footerColumns(items: readonly ThemeNavigationItem[]): string {
  const columns: { heading: string; items: ThemeNavigationItem[] }[] = [];
  for (const item of items) {
    const heading = item.group ?? '';
    const column = columns.find(candidate => candidate.heading === heading);
    if (column) column.items.push(item); else columns.push({ heading, items: [item] });
  }
  return columns.map(column => `<div class="footer-nav-col">
      ${column.heading ? `<p class="footer-heading">${escapeHtml(column.heading)}</p>` : ''}
      <nav class="footer-links">${links(column.items)}</nav>
    </div>`).join('');
}

export function layout({ title, body, ctx }: LayoutOptions): string {
  const accent = escapeHtml(ctx.options.accentColor ?? '#8C3E28');
  const tagline = escapeHtml(ctx.tagline ?? '');
  const supportEmail = ctx.supportEmail ? escapeHtml(ctx.supportEmail) : '';
  const primaryNav = links(ctx.navigation?.primary ?? []);
  const footerNav = footerColumns(ctx.navigation?.footer ?? []);
  const footerNote = ctx.footerNote ? escapeHtml(ctx.footerNote) : '';
  return `<!doctype html>
<html lang="${escapeHtml(ctx.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(ctx.storeName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${escapeHtml(GOOGLE_FONTS_HREF)}">
<style>${styles(accent)}</style>
<!--
  字型由 Google Fonts 提供：它按 unicode-range 切成上百個分片，一般繁中頁面只取回幾十 KB，
  自託管整包 Noto Sans TC 則是 5.42 MB。代價是顧客的 IP 會送到 Google，見 ADR 0026。
  仍然不載入任何第三方 script；所有購買操作是標準 POST 表單，沒有 JavaScript 也能下單。
-->
</head>
<body>
<a class="skip-link" href="#main-content">跳至主要內容</a>
<header class="site-header">
  <div class="site-header__inner">
    <div class="brand-lockup">
      <a class="brand" href="/">${escapeHtml(ctx.storeName)}</a>
      ${tagline ? `<p class="tagline">${tagline}</p>` : ''}
    </div>
    <nav class="site-nav" aria-label="主要導覽">${primaryNav}</nav>
    <nav class="account" aria-label="帳戶操作">${accountNav(ctx)}</nav>
  </div>
</header>
<main id="main-content" tabindex="-1">${ctx.notice ? `<p class="notice" role="status">${escapeHtml(ctx.notice)}</p>` : ''}${body}</main>
<footer class="site-footer">
  <div class="site-footer__inner">
    <div class="footer-brand-col">
      <div class="brand-lockup">
        <a class="brand" href="/">${escapeHtml(ctx.storeName)}</a>
        ${tagline ? `<p class="tagline">${tagline}</p>` : ''}
      </div>
      ${footerNote ? `<p class="footer-desc">${footerNote}</p>` : ''}
      ${supportEmail ? `<p><a class="footer-email" href="mailto:${supportEmail}">${supportEmail}</a></p>` : ''}
    </div>
    ${footerNav}
  </div>
  <div class="site-footer__bottom">
    <div class="site-footer__bottom-inner">
      <span>&copy; ${new Date().getFullYear()} ${escapeHtml(ctx.storeName)} · All rights reserved.</span>
      <span class="footer-note">Storefront</span>
    </div>
  </div>
</footer>
</body>
</html>`;
}

function styles(accent: string): string {
  return `
:root {
  --accent: ${accent};
  --accent-hover: color-mix(in srgb, var(--accent) 85%, #000);
  --surface-canvas: #f7f3ed;
  --surface-raised: #fffdfc;
  --surface-muted: #eee7de;
  --surface-tint: #f4ece2;
  --ink-strong: #2b2520;
  --ink-muted: #675d55;
  --ink-faint: #968b81;
  --ink-inverse: #fff;
  --line-subtle: #dcd1c5;
  --line-strong: #b8aba0;
  --state-focus: #17673c;
  --state-success: #36684a;
  --state-warning: #8a5a12;
  --state-danger: #a83232;
  --state-danger-ink: #7f1d1d;
  --state-danger-surface: #fff4f3;
  --font-sans: "Noto Sans TC", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", sans-serif;
  /* 標題的 serif 走系統字型：自託管一份 7.66 MB 的 Noto Serif TC，
     只為了標題而讓每位新訪客多付這個流量，不划算。 */
  --font-serif: "Songti TC", "Noto Serif CJK TC", "Source Han Serif TC", "Times New Roman", serif;
}
* { box-sizing: border-box; }
html { background: var(--surface-canvas); }
body {
  min-width: 320px;
  margin: 0;
  background: var(--surface-canvas);
  color: var(--ink-strong);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.6;
}
a { color: inherit; }
a:hover { text-decoration-thickness: 2px; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
button[disabled] { cursor: not-allowed; opacity: .55; }
:focus-visible { outline: 3px solid var(--state-focus); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; }
}
.skip-link {
  position: fixed;
  z-index: 10;
  top: .75rem;
  left: .75rem;
  transform: translateY(-180%);
  border-radius: .45rem;
  padding: .55rem .8rem;
  background: var(--ink-strong);
  color: var(--ink-inverse);
  font-weight: 700;
  text-decoration: none;
}
.skip-link:focus { transform: translateY(0); }

.site-header {
  position: sticky;
  z-index: 5;
  top: 0;
  border-bottom: 1px solid var(--line-subtle);
  background: color-mix(in srgb, var(--surface-raised) 94%, transparent);
  backdrop-filter: blur(8px);
}
.site-header__inner {
  display: grid;
  width: min(100% - 2rem, 74rem);
  min-height: 5.25rem;
  margin: 0 auto;
  grid-template-columns: minmax(12rem, 1fr) auto minmax(16rem, 1fr);
  align-items: center;
  gap: 1.2rem;
}
.brand-lockup { min-width: 0; }
.brand {
  display: inline-flex;
  align-items: center;
  gap: .55rem;
  color: var(--ink-strong);
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -.025em;
  text-decoration: none;
}
.brand__mark {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-family: var(--font-serif);
  font-size: 1.15rem;
  font-style: italic;
  font-weight: 500;
}
.tagline { margin: .15rem 0 0 2.55rem; color: var(--ink-muted); font-size: .78rem; }
.site-nav, .account {
  display: flex;
  align-items: center;
  gap: 1.1rem;
  font-size: .88rem;
}
.site-nav { justify-content: center; }
.site-nav a { text-decoration: none; font-weight: 500; color: var(--ink-muted); transition: color .15s; }
.site-nav a:hover { color: var(--ink-strong); }
.site-nav a, .account a, .site-footer a { text-underline-offset: .18em; }
.account { justify-content: flex-end; flex-wrap: wrap; color: var(--ink-muted); }
.account a { text-decoration: none; font-weight: 500; }
.account a:hover { color: var(--ink-strong); }
.account__name { color: var(--ink-strong); font-weight: 600; }

main { width: min(100% - 2rem, 74rem); margin: 0 auto; padding: clamp(2rem, 4vw, 4.5rem) 0 5rem; }

/* 豐富頁尾 */
.site-footer {
  border-top: 1px solid var(--line-subtle);
  background: var(--surface-raised);
  color: var(--ink-muted);
  font-size: .85rem;
}
.site-footer__inner {
  display: grid;
  grid-template-columns: minmax(16rem, 2fr) repeat(3, minmax(10rem, 1fr));
  width: min(100% - 2rem, 74rem);
  margin: 0 auto;
  padding: 3.5rem 0 2.5rem;
  gap: 2.5rem;
}
.footer-brand-col { display: grid; gap: 1rem; align-content: start; }
.footer-desc { margin: 0; color: var(--ink-muted); font-size: .88rem; line-height: 1.7; max-width: 24rem; }
.footer-heading { margin: 0 0 1rem; color: var(--ink-strong); font-weight: 700; font-size: .92rem; letter-spacing: .02em; }
.footer-links { display: grid; gap: .65rem; }
.footer-links a { text-decoration: none; color: var(--ink-muted); transition: color .15s; }
.footer-links a:hover { color: var(--ink-strong); text-decoration: underline; }
.footer-contact { margin: 0 0 .5rem; line-height: 1.6; }
.footer-email { color: var(--accent); font-weight: 600; text-decoration: none; }
.footer-email:hover { text-decoration: underline; }
.site-footer__bottom {
  border-top: 1px solid var(--line-subtle);
  padding: 1.5rem 0;
  font-size: .8rem;
}
.site-footer__bottom-inner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: min(100% - 2rem, 74rem);
  margin: 0 auto;
}
.footer-note { color: var(--ink-faint); font-family: var(--font-serif); font-style: italic; }

h1, h2, h3, h4, p { overflow-wrap: anywhere; }
h1, h2, h3, h4 { color: var(--ink-strong); }
h1 { margin: 0; font-family: var(--font-serif); font-size: clamp(2.25rem, 5vw, 4.6rem); font-weight: 500; letter-spacing: -.055em; line-height: .98; }
h2 { font-family: var(--font-serif); font-weight: 500; letter-spacing: -.035em; }
h3 { font-family: var(--font-serif); font-weight: 600; }
.muted { color: var(--ink-muted); font-size: .875rem; }
.price { color: var(--ink-strong); font-size: 1.05rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.notice, .error {
  margin: 0 0 1.25rem;
  border: 1px solid var(--line-subtle);
  border-radius: .7rem;
  padding: .9rem 1rem;
  background: var(--surface-raised);
}
.notice { border-color: color-mix(in srgb, var(--state-success) 40%, var(--line-subtle)); }
.error { border-color: var(--state-danger); color: var(--state-danger-ink); background: var(--state-danger-surface); }
.notice p, .error p { margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1rem; }
.card {
  border: 1px solid var(--line-subtle);
  border-radius: .75rem;
  padding: 1.25rem;
  background: var(--surface-raised);
}
.card h2 { margin: 0 0 .35rem; font-size: 1.35rem; }
form { display: grid; max-width: 28rem; gap: .85rem; margin-top: 1.5rem; }
label { display: grid; gap: .35rem; color: var(--ink-strong); font-size: .875rem; font-weight: 600; }
input, select, textarea {
  width: 100%;
  min-height: 2.75rem;
  border: 1px solid var(--line-subtle);
  border-radius: .55rem;
  padding: .55rem .7rem;
  background: var(--surface-raised);
  color: var(--ink-strong);
}
textarea { min-height: 5.5rem; resize: vertical; }
input:disabled { cursor: not-allowed; background: var(--surface-muted); color: var(--ink-muted); }
input[type=number] { font-variant-numeric: tabular-nums; }
button, .cta {
  display: inline-flex;
  min-height: 2.8rem;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: .55rem;
  padding: .65rem 1.25rem;
  background: var(--accent);
  color: var(--ink-inverse);
  font-weight: 700;
  text-decoration: none;
  transition: all .15s ease;
}
button:hover:not([disabled]), .cta:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
table { width: 100%; margin-top: 1rem; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: .8rem .6rem; border-bottom: 1px solid var(--line-subtle); text-align: left; vertical-align: top; font-size: .875rem; }
th { color: var(--ink-muted); font-size: .75rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.badge {
  display: inline-block;
  border: 1px solid var(--line-subtle);
  border-radius: 999px;
  padding: .12rem .5rem;
  color: var(--ink-muted);
  font-size: .75rem;
}
.coupon { margin: 1.5rem 0; }
.cart-actions { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; }
.expiring { color: var(--state-warning); font-weight: 700; }
.inline { display: inline-flex; max-width: none; align-items: center; gap: .45rem; margin: 0; }
.inline input[type=number] { width: 5rem; min-height: 2.25rem; }
.linklike { min-height: auto; border: 0; padding: 0; background: none; color: var(--accent); font-weight: 500; text-decoration: underline; text-underline-offset: .18em; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.secondary-action {
  display: inline-flex;
  min-height: 2.8rem;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-subtle);
  border-radius: .55rem;
  padding: .65rem 1.25rem;
  background: var(--surface-raised);
  color: var(--ink-strong);
  font-weight: 700;
  text-decoration: none;
  transition: all .15s ease;
}
.secondary-action:hover { background: var(--surface-muted); border-color: var(--line-strong); }

/* 首頁型錄與品牌生活提案 */
.catalog-page { display: grid; gap: clamp(3.5rem, 7vw, 6rem); }

/* 沉浸式雜誌首頁 Editorial Hero */
.editorial-hero {
  position: relative;
  min-height: min(36rem, 72vw);
  border-radius: 1.5rem;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  padding: clamp(2.5rem, 6vw, 5.5rem);
  box-shadow: 0 12px 40px -10px rgba(43, 37, 32, .18);
  border: 1px solid rgba(220, 209, 197, .5);
}
.editorial-hero__bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 35%;
  transform: scale(1.02);
  transition: transform .8s ease;
}
.editorial-hero__overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(28, 22, 18, .88) 0%, rgba(28, 22, 18, .45) 55%, rgba(28, 22, 18, .15) 100%);
}
.editorial-hero__content {
  position: relative;
  z-index: 2;
  color: #FFFDF9;
  max-width: 44rem;
  display: grid;
  gap: .75rem;
}
.editorial-hero__eyebrow {
  margin: 0;
  color: #E2B9A0;
  font-size: .78rem;
  font-weight: 700;
  letter-spacing: .16em;
  text-transform: uppercase;
}
.editorial-hero h1 {
  margin: 0;
  color: #FFFDF9;
  font-size: clamp(2.2rem, 4.5vw, 3.4rem);
  line-height: 1.2;
}
.editorial-hero__copy {
  margin: .4rem 0 1.2rem;
  color: rgba(255, 253, 249, .88);
  font-size: 1.08rem;
  line-height: 1.8;
  max-width: 36rem;
}
.editorial-hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: .85rem;
  align-items: center;
}
.editorial-hero__actions .cta {
  background: var(--accent);
  color: #FFF;
  border-color: var(--accent);
}
.editorial-hero__actions .cta:hover {
  background: var(--accent-hover);
}
.editorial-hero__actions .secondary-action {
  background: rgba(255, 253, 249, .15);
  color: #FFFDF9;
  border-color: rgba(255, 253, 249, .4);
  backdrop-filter: blur(8px);
}
.editorial-hero__actions .secondary-action:hover {
  background: rgba(255, 253, 249, .25);
  border-color: #FFF;
}

.catalog-section { display: grid; gap: 1.5rem; }
.catalog-section__header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.catalog-section__header h2 { margin: 0; font-size: clamp(1.65rem, 3vw, 2.4rem); }
.catalog-section__count { margin: 0; color: var(--ink-muted); font-size: .85rem; }

.catalog-search { display: grid; grid-template-columns: minmax(12rem, 2fr) repeat(2, minmax(7rem, 1fr)) auto; align-items: end; gap: .65rem; max-width: 48rem; }
.catalog-search label { display: grid; flex: 1; gap: .35rem; color: var(--ink-muted); font-size: .82rem; font-weight: 700; }
.catalog-search input { width: 100%; }
.catalog-pagination { display: flex; align-items: center; justify-content: center; gap: 1rem; color: var(--ink-muted); font-size: .88rem; }
.catalog-pagination span { min-width: 3.5rem; text-align: center; }

.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17.5rem, 1fr));
  gap: 1.5rem;
}
.product-card {
  border: 1px solid var(--line-subtle);
  border-radius: 1.15rem;
  background: var(--surface-raised);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: transform .25s cubic-bezier(.16, 1, .3, 1), box-shadow .25s ease, border-color .25s ease;
}
.product-card:hover {
  transform: translateY(-4px);
  border-color: var(--line-strong);
  box-shadow: 0 14px 30px -8px rgba(43, 37, 32, .12);
}
.product-card__photo-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: var(--surface-muted);
  overflow: hidden;
  border-bottom: 1px solid var(--line-subtle);
}
.product-card__photo {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  display: block;
  transition: transform .5s cubic-bezier(.16, 1, .3, 1);
}
.product-card:hover .product-card__photo {
  transform: scale(1.06);
}
.product-card__category-badge {
  position: absolute;
  top: .85rem;
  left: .85rem;
  background: rgba(255, 253, 252, .92);
  backdrop-filter: blur(6px);
  color: var(--ink-strong);
  font-size: .72rem;
  font-weight: 700;
  padding: .25rem .65rem;
  border-radius: 999px;
  border: 1px solid rgba(220, 209, 197, .7);
  box-shadow: 0 2px 8px rgba(43, 37, 32, .08);
  letter-spacing: .04em;
}
.product-card__link {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: space-between;
  padding: 1.4rem;
  text-decoration: none;
}
.product-card__content { min-width: 0; }
.product-card__tag {
  display: inline-block;
  background: var(--surface-tint);
  color: var(--accent);
  font-size: .72rem;
  font-weight: 700;
  padding: .2rem .55rem;
  border-radius: 999px;
  margin-bottom: .6rem;
  width: fit-content;
}
.product-card__sku { margin: 0; color: var(--ink-faint); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
.product-card h2 { margin: .45rem 0 0; font-size: clamp(1.18rem, 2vw, 1.4rem); line-height: 1.3; }
.product-card__description { margin: .75rem 0 0; color: var(--ink-muted); font-size: .88rem; line-height: 1.6; }
.product-card__footer { display: flex; align-items: end; justify-content: space-between; gap: .75rem; margin-top: 1.4rem; padding-top: 1rem; border-top: 1px solid var(--line-subtle); }
.product-card__availability { margin: 0; color: var(--state-success); font-size: .8rem; font-weight: 700; text-align: end; }
.product-card__availability--sold-out { color: var(--state-danger); }

/* 品牌誌生活專欄 Woven Journal */
.journal-section { display: grid; gap: 1.5rem; }
.journal-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; }
.journal-card {
  border: 1px solid var(--line-subtle);
  border-radius: 1.25rem;
  overflow: hidden;
  background: var(--surface-raised);
  display: flex;
  flex-direction: column;
  text-decoration: none;
  transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease;
}
.journal-card:hover {
  transform: translateY(-3px);
  border-color: var(--line-strong);
  box-shadow: 0 12px 28px -8px rgba(43, 37, 32, .1);
}
.journal-card__cover-wrap {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--surface-muted);
  overflow: hidden;
}
.journal-card__cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform .5s ease;
}
.journal-card:hover .journal-card__cover {
  transform: scale(1.05);
}
.journal-card__body {
  padding: 1.8rem;
  display: grid;
  gap: .75rem;
  flex: 1;
}
.journal-card__meta { display: flex; gap: .75rem; color: var(--accent); font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.journal-card h3 { margin: 0; font-size: 1.35rem; line-height: 1.35; }
.journal-card p { margin: 0; color: var(--ink-muted); font-size: .92rem; line-height: 1.7; }
.journal-card__read { color: var(--accent); font-weight: 700; font-size: .85rem; margin-top: .4rem; display: inline-flex; align-items: center; gap: .3rem; }

/* 最新消息 /news、常見問題 /faq、聯絡我們 /contact */

/*
  Honeypot。它必須真的離開視線：一個看得見的「請不要填寫」欄位，
  只會讓手滑或密碼管理器自動填入的真人被當成機器人靜靜丟掉。
  用位移而不是 display:none —— 後者有些自動填入工具會直接跳過。
*/
.contact-hp {
  position: absolute;
  left: -9999px;
  width: 1px;
  height: 1px;
  overflow: hidden;
}

.news-page, .faq-page, .contact-page { display: grid; gap: clamp(2.5rem, 5vw, 4rem); }

.news-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 1.5rem; }
.news-row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: clamp(1rem, 3vw, 2.5rem);
  align-items: baseline;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--line-subtle);
}
.news-row:last-child { border-bottom: 0; padding-bottom: 0; }
.news-row time { color: var(--ink-muted); font-size: .85rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.news-row__copy { display: grid; gap: .5rem; }
.news-row__meta { margin: 0; color: var(--accent); font-size: .78rem; font-weight: 700; letter-spacing: .06em; }
.news-row h3 { margin: 0; font-size: 1.25rem; line-height: 1.4; }
.news-row p { margin: 0; color: var(--ink-muted); font-size: .92rem; line-height: 1.7; }
.news-list--compact .news-row:last-child { border-bottom: 0; }
@media (max-width: 40rem) {
  .news-row { grid-template-columns: 1fr; gap: .5rem; }
}

.faq-group { display: grid; gap: 1.25rem; }
.faq-group__title { margin: 0; font-size: 1.05rem; color: var(--accent); letter-spacing: .04em; }
.faq-list { margin: 0; display: grid; gap: 1.25rem; }
.faq-item { padding-bottom: 1.25rem; border-bottom: 1px solid var(--line-subtle); }
.faq-item:last-child { border-bottom: 0; padding-bottom: 0; }
.faq-item dt { font-weight: 700; font-size: 1.05rem; margin-bottom: .6rem; }
.faq-item dd { margin: 0; color: var(--ink-muted); line-height: 1.8; display: grid; gap: .75rem; }
.faq-closing { color: var(--ink-muted); }
.faq-closing a { color: var(--accent); font-weight: 700; }

.contact-form { display: grid; gap: 1.25rem; max-width: 34rem; }
.contact-form .field { display: grid; gap: .35rem; }
.contact-form .field > span { font-weight: 700; font-size: .9rem; }
.contact-form input, .contact-form textarea {
  width: 100%;
  padding: .7rem .85rem;
  border: 1px solid var(--line-subtle);
  border-radius: .6rem;
  background: var(--surface-raised);
  color: inherit;
  font: inherit;
}
.contact-form textarea { resize: vertical; line-height: 1.7; }
.contact-form input:focus-visible, .contact-form textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.contact-form .cta { justify-self: start; }
.contact-done { display: grid; gap: .75rem; max-width: 34rem; }
.contact-done h2 { margin: 0; }
.contact-done p { margin: 0; color: var(--ink-muted); line-height: 1.8; }
.contact-done .secondary-action { justify-self: start; }
.contact-support { color: var(--ink-muted); font-size: .92rem; }
.contact-support a { color: var(--accent); font-weight: 700; }

/* 送出失敗的原因要看得出來是錯誤，不是一段說明文字。 */
.form-error {
  margin: 0;
  padding: .75rem 1rem;
  border-radius: .6rem;
  border: 1px solid var(--state-danger);
  background: var(--state-danger-surface);
  color: var(--state-danger-ink);
  font-size: .9rem;
}

/* 首頁的最新消息區塊與品牌故事的前言段落 */
.storefront-news { display: grid; gap: 1.75rem; }
.brand-story-lead { display: grid; gap: 1rem; max-width: 44rem; color: var(--ink-muted); line-height: 1.9; }
.brand-story-lead p { margin: 0; }
.article-block { display: grid; gap: .6rem; }
.article-block h2 { margin: 0; font-size: 1.2rem; }
.article-block p { margin: 0; }

/* 品牌故事獨立專頁 /story */
.story-page { display: grid; gap: clamp(3.5rem, 6vw, 5.5rem); }
.story-hero {
  position: relative;
  min-height: min(30rem, 60vw);
  border-radius: 1.5rem;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  padding: clamp(2.5rem, 6vw, 4.5rem);
}
.story-hero__bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.story-hero__overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(28, 22, 18, .9) 0%, rgba(28, 22, 18, .35) 60%, rgba(28, 22, 18, .1) 100%);
}
.story-hero__content {
  position: relative;
  z-index: 2;
  color: #FFFDF9;
  max-width: 40rem;
}
.story-hero__content h1 {
  margin: 0 0 .75rem;
  color: #FFFDF9;
  font-size: clamp(2rem, 4vw, 3rem);
}
.story-intro {
  max-width: 46rem;
  margin: 0 auto;
  text-align: center;
  display: grid;
  gap: 1.25rem;
}
.story-intro h2 { font-size: clamp(1.8rem, 3vw, 2.4rem); margin: 0; }
.story-intro p { font-size: 1.12rem; line-height: 1.9; color: var(--ink-muted); margin: 0; }

.story-craft-section { display: grid; gap: 2.5rem; }
.story-craft-card {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: clamp(2rem, 5vw, 4rem);
  align-items: center;
  border: 1px solid var(--line-subtle);
  border-radius: 1.25rem;
  overflow: hidden;
  background: var(--surface-raised);
}
.story-craft-card--reverse {
  direction: rtl;
}
.story-craft-card--reverse .story-craft-body {
  direction: ltr;
}
.story-craft-photo {
  width: 100%;
  height: 100%;
  min-height: 20rem;
  object-fit: cover;
  display: block;
}
.story-craft-body {
  padding: clamp(2rem, 4vw, 3.5rem);
  display: grid;
  gap: .85rem;
}
.story-craft-num { font-family: var(--font-serif); font-size: 1.6rem; color: var(--accent); font-weight: 700; }
.story-craft-body h3 { font-size: 1.65rem; margin: 0; }
.story-craft-body p { margin: 0; color: var(--ink-muted); font-size: 1rem; line-height: 1.8; }

/* 品牌誌深度閱讀專題 /journal/:slug */
.journal-article-page {
  max-width: 48rem;
  margin: 0 auto;
  display: grid;
  gap: 2.5rem;
}
.article-header { display: grid; gap: 1rem; }
.article-header h1 { font-size: clamp(2rem, 4vw, 2.8rem); line-height: 1.25; margin: 0; }
.article-meta { display: flex; gap: 1rem; color: var(--ink-faint); font-size: .85rem; font-weight: 600; }
.article-hero-wrap {
  border-radius: 1.25rem;
  overflow: hidden;
  box-shadow: 0 8px 24px -6px rgba(43, 37, 32, .12);
}
.article-hero-img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
}
.article-content {
  font-size: 1.08rem;
  line-height: 1.95;
  color: var(--ink-strong);
  display: grid;
  gap: 1.4rem;
}
.article-content p { margin: 0; }
.article-content h2 { margin: 1.5rem 0 .5rem; font-size: 1.55rem; color: var(--ink-strong); }
.article-content ol, .article-content ul { padding-left: 1.5rem; margin: 0; display: grid; gap: .6rem; }
.article-lead { font-size: 1.22rem; line-height: 1.8; color: var(--ink-strong); font-family: var(--font-serif); border-left: 3px solid var(--accent); padding-left: 1.2rem; }

/* 會員專屬邀請 Member Banner */
.member-banner {
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line-subtle));
  border-radius: 1.5rem;
  padding: clamp(2.5rem, 5vw, 4rem);
  background: linear-gradient(135deg, var(--surface-raised), var(--surface-tint));
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2rem;
  align-items: center;
}
.member-banner__content h2 { margin: 0 0 .5rem; font-size: clamp(1.6rem, 3vw, 2.2rem); }
.member-banner__content p { margin: 0; color: var(--ink-muted); font-size: 1rem; line-height: 1.6; }
.member-banner__actions { display: flex; gap: .8rem; flex-wrap: wrap; }

.empty-state { max-width: 34rem; margin: 0; border: 1px dashed var(--line-subtle); border-radius: .8rem; padding: 1.25rem; color: var(--ink-muted); background: var(--surface-raised); }

/* 商品詳情頁面增強 */
.product-page { display: grid; gap: 2.5rem; }
.breadcrumb { color: var(--ink-muted); font-size: .85rem; }
.breadcrumb a { text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
.product-detail { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(20rem, .85fr); gap: clamp(2rem, 6vw, 4.5rem); align-items: start; }
.product-detail__content { min-width: 0; display: grid; gap: 1.8rem; }
.product-hero-photo-wrap {
  border: 1px solid var(--line-subtle);
  border-radius: 1.25rem;
  overflow: hidden;
  background: var(--surface-muted);
  position: relative;
  aspect-ratio: 4 / 3;
  box-shadow: 0 8px 30px -10px rgba(43, 37, 32, .1);
}
.product-hero-photo {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.product-hero-photo__badge {
  position: absolute;
  bottom: 1.25rem;
  left: 1.25rem;
  background: rgba(255, 253, 252, .94);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(220, 209, 197, .8);
  padding: .6rem 1.1rem;
  border-radius: .85rem;
  display: grid;
  gap: .15rem;
  box-shadow: 0 4px 12px rgba(43, 37, 32, .06);
}
.product-hero-photo__badge span {
  font-size: .68rem;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--accent);
  letter-spacing: .08em;
}
.product-hero-photo__badge strong {
  font-family: var(--font-serif);
  font-size: .98rem;
  color: var(--ink-strong);
}
.product-detail__sku { margin: 0; color: var(--ink-faint); font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; }
.product-detail__description { margin: 0; color: var(--ink-muted); font-size: 1.08rem; line-height: 1.8; }

.product-specs {
  margin-top: 1rem;
  border-top: 1px solid var(--line-subtle);
  padding-top: 1.5rem;
  display: grid;
  gap: 1.25rem;
}
.product-specs h3 { margin: 0; font-size: 1.15rem; }
.product-specs-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.spec-item dt { color: var(--ink-faint); font-size: .76rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin-bottom: .2rem; }
.spec-item dd { margin: 0; color: var(--ink-strong); font-size: .92rem; }

.product-purchase { border: 1px solid var(--line-subtle); border-radius: 1.25rem; padding: clamp(1.5rem, 3vw, 2.25rem); background: var(--surface-raised); box-shadow: 0 6px 20px -6px rgba(43, 37, 32, .08); }
.product-purchase__label { margin: 0; color: var(--ink-faint); font-size: .76rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.product-purchase .price { margin: .45rem 0 0; font-size: 1.85rem; }
.product-purchase__availability { margin: .8rem 0 0; color: var(--state-success); font-size: .86rem; font-weight: 700; }
.product-purchase__availability--sold-out { color: var(--state-danger); }
.product-form { max-width: none; margin-top: 1.2rem; }
.product-form__hint { margin: -.35rem 0 0; color: var(--ink-muted); font-size: .78rem; }
.product-guarantees { margin-top: 1.5rem; border-top: 1px solid var(--line-subtle); padding-top: 1.2rem; display: grid; gap: .65rem; font-size: .84rem; color: var(--ink-muted); }
.product-guarantees div { display: flex; align-items: center; gap: .6rem; }
.product-guarantees .guarantee-icon { color: var(--accent); display: flex; }

/* 購物流程頁面 */
.page-heading { max-width: 42rem; }
.page-heading__copy { max-width: 38rem; margin: 1rem 0 0; color: var(--ink-muted); font-size: 1rem; }
.cart-page, .checkout-page, .account-page, .order-page { display: grid; gap: clamp(1.5rem, 4vw, 2.75rem); }
.section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.section-heading h2 { margin: 0; font-size: clamp(1.35rem, 3vw, 1.8rem); }
.section-heading p { margin: 0; color: var(--ink-muted); font-size: .84rem; }
.cart-layout, .checkout-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(17rem, .55fr);
  gap: clamp(1.5rem, 4vw, 3.25rem);
  align-items: start;
}
.cart-content, .checkout-content { min-width: 0; }
.cart-sidebar, .checkout-sidebar { position: sticky; top: 1.25rem; }
.cart-table { margin-top: 1.1rem; }
.cart-table__product { min-width: 12rem; }
.cart-table__product-name { font-weight: 700; text-underline-offset: .18em; }
.cart-table__sku, .cart-table__availability { margin: .2rem 0 0; color: var(--ink-muted); font-size: .75rem; }
.cart-table__sku { letter-spacing: .06em; text-transform: uppercase; }
.cart-table__availability { color: var(--state-success); font-weight: 700; }
.cart-table__availability--unavailable { color: var(--state-danger); }
.cart-table__net { font-weight: 700; }
.cart-quantity-form { flex-wrap: nowrap; }
.cart-quantity-form button { min-height: 2.25rem; padding: .45rem .7rem; font-size: .8rem; }
.cart-option {
  margin-top: 1.25rem;
  border-top: 1px solid var(--line-subtle);
  padding-top: 1.25rem;
}
.cart-option h2 { margin: 0 0 .6rem; font-size: 1.1rem; }
.cart-option p { margin: 0 0 .75rem; }
.cart-option__form { align-items: end; }
.order-summary, .checkout-submit, .order-total-card {
  border: 1px solid var(--line-subtle);
  border-radius: .85rem;
  padding: 1.25rem;
  background: var(--surface-raised);
}
.order-summary h2 { margin: 0 0 1rem; font-size: 1.2rem; }
.order-summary dl { display: grid; gap: .7rem; margin: 0; }
.order-summary__row { display: flex; justify-content: space-between; gap: 1rem; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.order-summary__row dt, .order-summary__row dd { margin: 0; }
.order-summary__row dd { color: var(--ink-strong); text-align: end; }
.order-summary__row--total { margin-top: .25rem; border-top: 1px solid var(--line-subtle); padding-top: 1rem; color: var(--ink-strong); font-size: 1.05rem; font-weight: 700; }
.order-summary__row--total dd { font-size: 1.22rem; }
.cart-sidebar { display: grid; gap: .9rem; }
.cart-sidebar__cta { width: 100%; }
.cart-sidebar__note { margin: 0; color: var(--ink-muted); font-size: .82rem; }
.cart-actions { margin-top: .25rem; border-top: 1px solid var(--line-subtle); padding-top: 1rem; }
.empty-state--cart { display: grid; gap: .8rem; max-width: 31rem; }
.empty-state--cart h2 { margin: 0; font-size: 1.6rem; }
.empty-state--cart p { margin: 0; }
.empty-state--cart .cta { justify-self: start; margin-top: .4rem; }
.checkout-email {
  margin-bottom: 1.5rem;
  border-left: 3px solid var(--accent);
  padding: .1rem 0 .1rem 1rem;
}
.checkout-email p { margin: 0; }
.checkout-email__label, .order-meta__label, .account-stat__label {
  color: var(--ink-muted);
  font-size: .74rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.checkout-submit { display: grid; gap: 1rem; margin-top: 1rem; }
.checkout-submit p { margin: 0; color: var(--ink-muted); font-size: .84rem; }
.checkout-submit form { max-width: none; margin: 0; }
.checkout-submit .secondary-action { width: 100%; }

/* 登入與會員中心 */
.auth-page { display: grid; min-height: 33rem; place-items: center; }
.auth-card {
  width: min(100%, 31rem);
  border: 1px solid var(--line-subtle);
  border-radius: 1rem;
  padding: clamp(1.35rem, 5vw, 2.5rem);
  background: var(--surface-raised);
}
.auth-card__header h1 { font-size: clamp(2.2rem, 5vw, 3.25rem); }
.auth-form { max-width: none; }
.auth-card__footer { margin: 1.4rem 0 0; color: var(--ink-muted); font-size: .875rem; }
.account-intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1.5rem 2rem;
  align-items: end;
}
.account-tabs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .35rem; }
.account-tabs a {
  border-radius: 999px;
  padding: .45rem .7rem;
  color: var(--ink-muted);
  font-size: .82rem;
  text-decoration: none;
}
.account-tabs a:hover { background: var(--surface-muted); color: var(--ink-strong); }
.account-tabs a[aria-current="page"] { background: var(--ink-strong); color: var(--ink-inverse); font-weight: 700; }
.account-stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.account-stat, .account-panel {
  border: 1px solid var(--line-subtle);
  border-radius: .85rem;
  padding: clamp(1rem, 3vw, 1.5rem);
  background: var(--surface-raised);
}
.account-stat p { margin: 0; }
.account-stat__value { margin-top: .35rem !important; color: var(--ink-strong); font-size: clamp(1.8rem, 4vw, 2.4rem); font-weight: 700; font-variant-numeric: tabular-nums; }
.account-stat h2 { margin: .35rem 0 0; font-size: clamp(1.5rem, 3vw, 2rem); }
.account-stat .muted { margin-top: .55rem; }
.account-panel { min-width: 0; }
.data-table { margin-top: 1rem; }
.data-table code { border-radius: .3rem; padding: .12rem .35rem; background: var(--surface-muted); color: var(--ink-strong); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
.order-status {
  display: inline-block;
  border: 1px solid color-mix(in srgb, var(--accent) 36%, var(--line-subtle));
  border-radius: 999px;
  padding: .2rem .55rem;
  color: var(--ink-strong);
  background: color-mix(in srgb, var(--surface-raised) 76%, var(--surface-canvas));
  font-size: .78rem;
  font-weight: 700;
}
.pagination { display: flex; justify-content: space-between; gap: 1rem; margin-top: 1.25rem; }
.pagination a { color: var(--accent); font-weight: 700; text-underline-offset: .2em; }
.profile-form {
  display: grid;
  max-width: none;
  gap: 1.5rem;
  margin: 0;
  border: 1px solid var(--line-subtle);
  border-radius: .85rem;
  padding: clamp(1rem, 3vw, 1.5rem);
  background: var(--surface-raised);
}
.profile-form__section { min-width: 0; margin: 0; border: 0; padding: 0; }
.profile-form__section + .profile-form__section { border-top: 1px solid var(--line-subtle); padding-top: 1.5rem; }
.profile-form__section h2, .profile-form__section legend { margin: 0 0 .85rem; padding: 0; font-family: var(--font-serif); font-size: 1.35rem; font-weight: 500; letter-spacing: -.035em; }
.profile-form__section > .muted { margin: -.35rem 0 1rem; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.profile-birthday { grid-column: 1 / -1; }
.profile-birthday .muted { margin: .4rem 0 0; }
.order-meta { display: flex; flex-wrap: wrap; gap: 1.5rem 3.5rem; border-top: 1px solid var(--line-subtle); border-bottom: 1px solid var(--line-subtle); padding: 1rem 0; }
.order-meta p { margin: 0; }
.order-meta__label { margin-bottom: .25rem !important; }
.order-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(13rem, .32fr); gap: 1.5rem; align-items: start; }
.order-total-card { position: sticky; top: 1.25rem; }
.order-total-card p { margin: 0; color: var(--ink-muted); font-size: .82rem; }
.order-total-card strong { display: block; margin-top: .4rem; font-size: 1.4rem; font-variant-numeric: tabular-nums; }
.page-return { margin: 0; }
.error-page { display: grid; min-height: 25rem; place-items: center; }
.error-page .error { width: min(100%, 33rem); margin: 0; }
.error-page .error h1 { margin: .25rem 0 .8rem; }
.error-page .secondary-action { margin-top: 1rem; }

/* 資料契約尚未提供商品媒體；以不指涉商品的原創圖形維持首頁與型錄的視覺節奏。 */
.storefront-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(17rem, .8fr);
  align-items: center;
  min-height: clamp(24rem, 48vw, 34rem);
  overflow: hidden;
  border: 1px solid var(--line-subtle);
  border-radius: 1.25rem;
  background: var(--surface-raised);
}
.storefront-hero__copy { display: grid; gap: 1.25rem; padding: clamp(2rem, 6vw, 5rem); }
.storefront-hero__copy .eyebrow { margin: 0; color: var(--accent); }
.storefront-hero__copy h1 { max-width: 12ch; font-size: clamp(2.8rem, 6vw, 5.25rem); }
.storefront-hero__copy > p:not(.eyebrow) { max-width: 28rem; margin: 0; color: var(--ink-muted); font-size: 1.05rem; }
.storefront-hero__copy .cta { justify-self: start; }
.storefront-hero__art { align-self: stretch; min-height: 15rem; color: var(--accent); background: var(--surface-tint); }
.storefront-artwork { display: block; width: 100%; height: 100%; }
.storefront-product-image { display: block; width: 100%; height: 100%; background-color: var(--surface-muted); background-repeat: no-repeat; background-size: 300% 300%; }
.storefront-editorial-image { display: block; width: 100%; height: 100%; object-fit: cover; }
.storefront-hero__art > .storefront-editorial-image { object-position: 58% center; }

.catalog-page > .storefront-hero { margin-bottom: clamp(3.5rem, 7vw, 7rem); }
.brand-manifesto { display: grid; grid-template-columns: minmax(16rem, .75fr) minmax(0, 1.25fr); gap: clamp(2rem, 6vw, 5rem); margin: 0 0 clamp(4rem, 9vw, 8rem); padding: clamp(2rem, 5vw, 4.5rem) 0; border-top: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-subtle); }
.brand-manifesto__copy { display: grid; align-content: start; justify-items: start; gap: 1.25rem; }
.brand-manifesto__copy .eyebrow, .brand-story-page .eyebrow, .journal-page .eyebrow, .article-header .eyebrow { margin: 0; color: var(--accent); }
.brand-manifesto__copy h2 { margin: 0; font-size: clamp(2rem, 4vw, 3.5rem); line-height: 1.1; }
.brand-manifesto__copy > p:not(.eyebrow) { margin: 0; color: var(--ink-muted); line-height: 1.85; }
.brand-manifesto__chapters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin: 0; padding: 1px; list-style: none; background: var(--line-subtle); }
.brand-manifesto__chapters li { display: grid; align-content: start; padding: 1.4rem; background: var(--surface-raised); }
.brand-manifesto__chapters span { color: var(--accent); font-size: .75rem; font-weight: 700; letter-spacing: .12em; }
.brand-manifesto__chapters h3 { margin: 2.5rem 0 .65rem; font-size: 1.2rem; }
.brand-manifesto__chapters p { margin: 0; color: var(--ink-muted); font-size: .88rem; line-height: 1.7; }
.storefront-journal { margin-top: clamp(4rem, 9vw, 8rem); }
.journal-card__cover-wrap > .storefront-editorial-image { transition: transform .45s ease; }
.journal-card__cover-wrap:hover > .storefront-editorial-image { transform: scale(1.03); }
.journal-grid--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }

.brand-story-page { display: grid; gap: clamp(4rem, 9vw, 8rem); }
.brand-story-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, .85fr); align-items: center; overflow: hidden; min-height: clamp(28rem, 55vw, 42rem); border: 1px solid var(--line-subtle); border-radius: 1.25rem; background: var(--surface-raised); }
.brand-story-hero > div:first-child { display: grid; justify-items: start; gap: 1.25rem; padding: clamp(2rem, 6vw, 5rem); }
.brand-story-hero h1 { max-width: 10ch; font-size: clamp(3rem, 6.5vw, 5.5rem); }
.brand-story-hero p:not(.eyebrow) { max-width: 31rem; margin: 0; color: var(--ink-muted); font-size: 1.05rem; line-height: 1.85; }
.brand-story-hero__art { align-self: stretch; min-height: 18rem; color: var(--accent); background: var(--surface-tint); }
.brand-story-hero__art > .storefront-editorial-image { object-position: 55% center; }
.brand-story-chapters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; }
.brand-story-chapters article { border-top: 1px solid var(--line-strong); padding-top: 1.25rem; }
.brand-story-chapters h2 { margin: 2rem 0 .8rem; font-size: clamp(1.55rem, 2.6vw, 2rem); }
.brand-story-chapters p:not(.eyebrow) { margin: 0; color: var(--ink-muted); line-height: 1.85; }
.brand-story-closing { display: grid; justify-items: center; gap: 1.2rem; padding: clamp(3rem, 8vw, 7rem) 1.5rem; text-align: center; background: var(--surface-tint); }
.brand-story-closing .eyebrow { margin: 0; color: var(--accent); }
.brand-story-closing h2 { max-width: 16ch; margin: 0; font-size: clamp(2.1rem, 4vw, 3.8rem); }
.journal-page { display: grid; gap: clamp(2rem, 5vw, 4rem); }
.article-header > p:not(.eyebrow) { max-width: 38rem; margin: 0; color: var(--ink-muted); font-size: 1.05rem; line-height: 1.8; }
.article-hero-art { overflow: hidden; border: 1px solid var(--line-subtle); border-radius: 1.25rem; aspect-ratio: 16 / 8; color: var(--accent); background: var(--surface-tint); }
.article-hero-art > .storefront-editorial-image { object-position: center 55%; }
.article-return { margin: 0; }
.catalog-page > .catalog-section + .storefront-discovery { margin-top: clamp(4rem, 9vw, 8rem); }
.storefront-discovery {
  display: grid;
  grid-template-columns: minmax(16rem, .85fr) minmax(0, 1fr);
  align-items: stretch;
  overflow: hidden;
  border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-strong);
  background: var(--surface-raised);
}
.storefront-discovery__art { min-height: 20rem; color: var(--accent); background: var(--surface-tint); }
.storefront-discovery__art > .storefront-editorial-image { object-position: 45% center; }
.storefront-discovery__copy { display: grid; align-content: center; justify-items: start; gap: 1.2rem; padding: clamp(2rem, 6vw, 5rem); }
.storefront-discovery__copy .eyebrow, .storefront-journey .eyebrow { margin: 0; color: var(--accent); }
.storefront-discovery__copy h2, .storefront-journey h2 { max-width: 13ch; margin: 0; font-size: clamp(2rem, 4vw, 3.6rem); }
.storefront-discovery__copy > p:not(.eyebrow) { max-width: 31rem; margin: 0; color: var(--ink-muted); line-height: 1.8; }
.storefront-journey { display: grid; grid-template-columns: minmax(15rem, .7fr) minmax(0, 1.5fr); gap: 2rem; align-items: start; margin-top: clamp(4rem, 9vw, 8rem); }
.storefront-journey__heading { display: grid; gap: 1rem; }
.storefront-journey__steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin: 0; padding: 1px; list-style: none; background: var(--line-subtle); }
.storefront-journey__steps li { min-height: 14rem; padding: 1.5rem; background: var(--surface-raised); }
.storefront-journey__steps span { color: var(--accent); font-size: .75rem; font-weight: 700; letter-spacing: .12em; }
.storefront-journey__steps h3 { margin: 2.8rem 0 .65rem; font-size: 1.25rem; }
.storefront-journey__steps p { margin: 0; color: var(--ink-muted); font-size: .9rem; line-height: 1.7; }

.product-card__art { aspect-ratio: 4 / 3; color: var(--accent); border-bottom: 1px solid var(--line-subtle); background: var(--surface-muted); }
.product-card__art .storefront-artwork { height: 100%; }
.product-card__art .storefront-product-image { transition: transform .45s cubic-bezier(.16, 1, .3, 1); }
.product-card:hover .storefront-product-image { transform: scale(1.035); }
.product-card__link { min-height: 14rem; }
.product-card h2 { font-size: clamp(1.3rem, 2.2vw, 1.7rem); }
.product-card__description { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }

.product-artwork { aspect-ratio: 4 / 3; overflow: hidden; border: 1px solid var(--line-subtle); border-radius: 1.1rem; color: var(--accent); background: var(--surface-muted); }
.product-artwork .storefront-artwork { height: 100%; }
.product-purchase { position: sticky; top: 6.5rem; }
.product-purchase__note { margin: 1.3rem 0 0; border-top: 1px solid var(--line-subtle); padding-top: 1.1rem; color: var(--ink-muted); font-size: .84rem; }

@media (max-width: 900px) {
  .site-header__inner { grid-template-columns: 1fr auto; padding: 1rem 0; }
  .site-nav { grid-row: 2; grid-column: 1 / -1; justify-content: flex-start; flex-wrap: wrap; }
  .account { align-self: start; }
  .site-footer__inner { grid-template-columns: 1fr 1fr; }
  .journal-grid { grid-template-columns: 1fr; }
  .member-banner { grid-template-columns: 1fr; }
  .storefront-hero { grid-template-columns: 1fr; }
  .storefront-hero__art { min-height: 18rem; }
  .brand-manifesto, .brand-story-hero { grid-template-columns: 1fr; }
  .brand-manifesto__chapters, .brand-story-chapters { grid-template-columns: repeat(3, 1fr); }
  .brand-story-hero__art { min-height: 20rem; }
  .journal-grid--three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .storefront-discovery, .storefront-journey { grid-template-columns: 1fr; }
  .storefront-discovery__art { min-height: 16rem; }
  .storefront-journey__steps { grid-template-columns: repeat(3, 1fr); }
  .product-detail { grid-template-columns: 1fr; gap: 1.5rem; }
  .product-purchase { position: static; max-width: 34rem; }
  .cart-layout, .checkout-layout, .order-layout { grid-template-columns: 1fr; }
  .cart-sidebar, .checkout-sidebar, .order-total-card { position: static; }
  .cart-sidebar, .checkout-sidebar { max-width: 34rem; }
  .account-intro { grid-template-columns: 1fr; align-items: start; }
  .account-tabs { justify-content: flex-start; }
}
@media (max-width: 620px) {
  .site-header__inner, main, .site-footer__inner, .site-footer__bottom-inner { width: min(100% - 1.25rem, 74rem); }
  .site-header__inner { gap: .85rem; }
  .tagline { margin-left: 0; }
  .account { gap: .55rem; font-size: .78rem; }
  .site-footer__inner { grid-template-columns: 1fr; gap: 2rem; }
  .site-footer__bottom-inner { flex-direction: column; gap: .5rem; text-align: center; }
  .catalog-hero { min-height: 22rem; padding: 1.5rem; }
  .storefront-hero__copy { padding: 2rem 1.5rem; }
  .storefront-hero__copy h1 { font-size: clamp(2.65rem, 13vw, 4rem); }
  .storefront-discovery__copy { padding: 2.5rem 1.5rem; }
  .brand-manifesto__chapters, .brand-story-chapters, .journal-grid--three { grid-template-columns: 1fr; }
  .brand-manifesto__chapters h3 { margin-top: 1.75rem; }
  .storefront-journey__steps { grid-template-columns: 1fr; }
  .storefront-journey__steps li { min-height: auto; padding: 1.4rem; }
  .storefront-journey__steps h3 { margin-top: 1.7rem; }
  .catalog-grid { grid-template-columns: 1fr; }
  .catalog-search { grid-template-columns: 1fr; align-items: stretch; }
  .product-card__link { min-height: 13rem; }
  .cart-actions { align-items: flex-start; flex-direction: column; }
  .section-heading { align-items: flex-start; flex-direction: column; gap: .25rem; }
  .account-stat-grid, .form-grid, .product-specs-list { grid-template-columns: 1fr; }
  .auth-page { min-height: auto; }
  .cart-option__form { width: 100%; flex-wrap: wrap; }
  .cart-option__form label { flex: 1 1 12rem; }
  .cart-table, .data-table { display: block; margin-top: .9rem; }
  .cart-table thead, .data-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  .cart-table tbody, .data-table tbody { display: grid; gap: .8rem; }
  .cart-table tr, .data-table tr {
    display: block;
    border: 1px solid var(--line-subtle);
    border-radius: .7rem;
    padding: .35rem 0;
    background: var(--surface-raised);
  }
  .cart-table td, .data-table td {
    display: grid;
    grid-template-columns: minmax(5.8rem, .75fr) minmax(0, 1.25fr);
    gap: .7rem;
    border: 0;
    padding: .55rem .75rem;
    white-space: normal;
  }
  .cart-table td::before, .data-table td::before {
    content: attr(data-label);
    color: var(--ink-muted);
    font-size: .72rem;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  .cart-table__product { display: block !important; min-width: 0; }
  .cart-table__product::before { content: none !important; }
  .cart-table__product-name { font-size: 1rem; }
  .cart-table__quantity .inline { justify-content: flex-end; }
  .cart-table__remove .inline { justify-content: flex-end; }
  .data-table .price { font-size: .95rem; }
}
`;
}
