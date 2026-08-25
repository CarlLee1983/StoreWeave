import type { ThemeContext } from '@storeweave/kernel';

/**
 * Google Fonts 的樣式表位址。字重範圍要與 `--font-sans` 的用法一致：
 * 400 內文、500/600 強調、700 標題。
 */
export const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400..700&display=swap';

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
    // fallback 也要轉義：currency 現在來自設定，但它會被插進 HTML。
    return `${(cents / 100).toFixed(2)} ${escapeHtml(currency)}`;
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
    return '<a href="/login">登入</a><a href="/register">註冊</a>';
  }
  return `<a href="/account/orders">會員中心</a><span class="account__name">${escapeHtml(ctx.customerName)}</span>
    <form method="post" action="/logout" class="inline">
      <button type="submit" class="linklike">登出</button>
    </form>`;
}

export function layout({ title, body, ctx }: LayoutOptions): string {
  const accent = escapeHtml(ctx.options.accentColor ?? '#8C3E28');
  const tagline = escapeHtml(ctx.options.tagline ?? '');
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
<div class="announcement-bar">
  <div class="announcement-bar__inner">
    <span>全站消費滿額享免運 ｜ 新會員加入現領專屬購物金 ｜ 7 日安心鑑賞保障</span>
  </div>
</div>
<header class="site-header">
  <div class="site-header__inner">
    <div class="brand-lockup">
      <a class="brand" href="/"><span class="brand__mark" aria-hidden="true">織</span><span>${escapeHtml(ctx.storeName)}</span></a>
      ${tagline ? `<p class="tagline">${tagline}</p>` : ''}
    </div>
    <nav class="site-nav" aria-label="主要導覽">
      <a href="/">首頁</a>
      <a href="/catalog">選物目錄</a>
      <a href="/story">品牌工藝</a>
      <a href="/journal">生活風格誌</a>
      <a href="/cart">購物車</a>
    </nav>
    <nav class="account" aria-label="帳戶操作">${accountNav(ctx)}</nav>
  </div>
</header>
<main id="main-content" tabindex="-1">${ctx.notice ? `<p class="notice" role="status">${escapeHtml(ctx.notice)}</p>` : ''}${body}</main>
<footer class="site-footer">
  <div class="site-footer__inner">
    <div class="footer-brand-col">
      <div class="brand-lockup">
        <a class="brand" href="/"><span class="brand__mark" aria-hidden="true">織</span><span>${escapeHtml(ctx.storeName)}</span></a>
        ${tagline ? `<p class="tagline">${tagline}</p>` : ''}
      </div>
      <p class="footer-desc">日日相伴的器物與織物，為生活採集溫潤本質。以天然材質與職人工藝，打造長久陪伴的日常之美。</p>
    </div>
    <div class="footer-nav-col">
      <p class="footer-heading">選物全系列</p>
      <nav class="footer-links">
        <a href="/catalog">所有選品</a>
        <a href="/catalog?q=器皿">日常器皿</a>
        <a href="/catalog?q=布">手織布品</a>
        <a href="/catalog?q=木">木作道具</a>
        <a href="/catalog?q=香氛">居家香氛</a>
      </nav>
    </div>
    <div class="footer-nav-col">
      <p class="footer-heading">品牌與專題</p>
      <nav class="footer-links">
        <a href="/story">品牌工藝宣言</a>
        <a href="/journal">生活風格誌</a>
        <a href="/account/rewards">會員購物金</a>
        <a href="/account/orders">訂單查詢</a>
      </nav>
    </div>
    <div class="footer-nav-col">
      <p class="footer-heading">聯絡與諮詢</p>
      <p class="footer-contact">客服時間：週一至週五 10:00 - 18:00</p>
      ${ctx.supportEmail ? `<p><a class="footer-email" href="mailto:${escapeHtml(ctx.supportEmail)}">${escapeHtml(ctx.supportEmail)}</a></p>` : ''}
    </div>
  </div>
  <div class="site-footer__bottom">
    <div class="site-footer__bottom-inner">
      <span>&copy; ${new Date().getFullYear()} ${escapeHtml(ctx.storeName)} · All rights reserved.</span>
      <span class="footer-note">Crafted with StoreWeave Architecture</span>
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
  --accent-light: color-mix(in srgb, var(--accent) 12%, var(--surface-raised));
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

/* 頂部公告列 */
.announcement-bar {
  background: var(--accent);
  color: var(--ink-inverse);
  font-size: .8rem;
  font-weight: 500;
  letter-spacing: .04em;
  text-align: center;
  padding: .5rem 1rem;
}
.announcement-bar__inner {
  width: min(100% - 2rem, 74rem);
  margin: 0 auto;
}

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

/* 品牌四大承諾 Brand Pillars (Zero Emojis, Minimalist Monochrome Icons) */
.brand-pillars {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14.5rem, 1fr));
  gap: 1.25rem;
}
.pillar-card {
  border: 1px solid var(--line-subtle);
  border-radius: 1rem;
  padding: 1.6rem;
  background: var(--surface-raised);
  display: grid;
  gap: .6rem;
  transition: transform .2s ease, box-shadow .2s ease;
}
.pillar-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px -6px rgba(43, 37, 32, .08);
}
.pillar-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: .2rem;
}
.pillar-num {
  font-family: var(--font-serif);
  color: var(--accent);
  font-size: .88rem;
  font-weight: 700;
  letter-spacing: .08em;
}
.pillar-icon-box {
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 50%;
  background: var(--surface-tint);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
}
.pillar-card h3 { margin: 0; font-size: 1.08rem; }
.pillar-card p { margin: 0; color: var(--ink-muted); font-size: .88rem; line-height: 1.65; }

/* 主題策展 Bento Collections */
.curated-section { display: grid; gap: 1.5rem; }
.curated-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.25rem;
}
.curated-card {
  position: relative;
  border-radius: 1.25rem;
  overflow: hidden;
  min-height: 19rem;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 1.8rem;
  text-decoration: none;
  border: 1px solid rgba(220, 209, 197, .5);
  box-shadow: 0 6px 18px -6px rgba(43, 37, 32, .08);
  transition: transform .3s cubic-bezier(.16, 1, .3, 1), box-shadow .3s ease;
}
.curated-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 14px 30px -8px rgba(43, 37, 32, .18);
}
.curated-card__bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform .6s cubic-bezier(.16, 1, .3, 1);
}
.curated-card:hover .curated-card__bg {
  transform: scale(1.06);
}
.curated-card__overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(28, 22, 18, .9) 0%, rgba(28, 22, 18, .4) 60%, rgba(28, 22, 18, .1) 100%);
}
.curated-card__content {
  position: relative;
  z-index: 2;
  color: #FFFDF9;
  display: grid;
  gap: .35rem;
}
.curated-card__tag {
  color: #E2B9A0;
  font-size: .72rem;
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
  margin: 0;
}
.curated-card h3 {
  margin: 0;
  color: #FFFDF9;
  font-size: 1.45rem;
}
.curated-card p {
  margin: 0;
  color: rgba(255, 253, 249, .82);
  font-size: .88rem;
  line-height: 1.6;
}
.curated-card__cta {
  margin-top: .75rem;
  color: #FFF;
  font-weight: 700;
  font-size: .85rem;
  display: inline-flex;
  align-items: center;
  gap: .4rem;
}

/* 商品選購區塊 */
.catalog-section { display: grid; gap: 1.5rem; }
.catalog-section__header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.catalog-section__header h2 { margin: 0; font-size: clamp(1.65rem, 3vw, 2.4rem); }
.catalog-section__count { margin: 0; color: var(--ink-muted); font-size: .85rem; }

/* 分類篩選 Tab */
.catalog-category-tabs {
  display: flex;
  gap: .6rem;
  flex-wrap: wrap;
  align-items: center;
  padding-bottom: .8rem;
  border-bottom: 1px solid var(--line-subtle);
}
.category-tab {
  display: inline-flex;
  align-items: center;
  padding: .45rem 1.1rem;
  border-radius: 999px;
  border: 1px solid var(--line-subtle);
  background: var(--surface-raised);
  color: var(--ink-muted);
  text-decoration: none;
  font-size: .85rem;
  font-weight: 600;
  transition: all .2s ease;
}
.category-tab:hover {
  color: var(--ink-strong);
  border-color: var(--line-strong);
  background: var(--surface-tint);
}
.category-tab--active {
  background: var(--accent);
  color: var(--ink-inverse);
  border-color: var(--accent);
}
.category-tab--active:hover {
  background: var(--accent-hover);
  color: var(--ink-inverse);
}

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

/* 品牌工藝理念專區 (首頁摘要) */
.philosophy-section {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr);
  gap: clamp(2rem, 5vw, 4rem);
  border: 1px solid var(--line-subtle);
  border-radius: 1.5rem;
  overflow: hidden;
  background: var(--surface-raised);
  align-items: center;
}
.philosophy-body {
  padding: clamp(2.5rem, 5vw, 4rem);
  display: grid;
  gap: 1.25rem;
}
.philosophy-body h2 { font-size: clamp(1.8rem, 3.5vw, 2.6rem); line-height: 1.2; margin: 0; }
.philosophy-body p { margin: 0; color: var(--ink-muted); font-size: 1.02rem; line-height: 1.8; }
.philosophy-photo-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 22rem;
}
.philosophy-photo {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

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

@media (max-width: 900px) {
  .site-header__inner { grid-template-columns: 1fr auto; padding: 1rem 0; }
  .site-nav { grid-row: 2; grid-column: 1 / -1; justify-content: flex-start; flex-wrap: wrap; }
  .account { align-self: start; }
  .site-footer__inner { grid-template-columns: 1fr 1fr; }
  .curated-grid { grid-template-columns: 1fr; }
  .philosophy-section { grid-template-columns: 1fr; }
  .journal-grid { grid-template-columns: 1fr; }
  .member-banner { grid-template-columns: 1fr; }
  .product-detail { grid-template-columns: 1fr; gap: 1.5rem; }
  .product-purchase { max-width: 34rem; }
  .cart-layout, .checkout-layout, .order-layout { grid-template-columns: 1fr; }
  .cart-sidebar, .checkout-sidebar, .order-total-card { position: static; }
  .cart-sidebar, .checkout-sidebar { max-width: 34rem; }
  .account-intro { grid-template-columns: 1fr; align-items: start; }
  .account-tabs { justify-content: flex-start; }
}
@media (max-width: 620px) {
  .site-header__inner, main, .site-footer__inner, .site-footer__bottom-inner, .announcement-bar__inner { width: min(100% - 1.25rem, 74rem); }
  .site-header__inner { gap: .85rem; }
  .tagline { margin-left: 0; }
  .account { gap: .55rem; font-size: .78rem; }
  .site-footer__inner { grid-template-columns: 1fr; gap: 2rem; }
  .site-footer__bottom-inner { flex-direction: column; gap: .5rem; text-align: center; }
  .catalog-hero { min-height: 22rem; padding: 1.5rem; }
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
