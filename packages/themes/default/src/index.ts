import { z } from 'zod';
import { defineTheme, type ThemeAuthView, type ThemeContext } from '@storeweave/kernel';
import type { AuthPages } from '@storeweave/auth';
import type { cartPages, ThemeCartView, ThemeCheckoutView, ThemePickupStorePickerView } from '@storeweave/cart';
import type { catalogPages, ThemeCatalogView, ThemeHomeView, ThemeProductView } from '@storeweave/catalog';
import type { contentPages, ThemeArticleListView, ThemeArticleView, ThemeContactView } from '@storeweave/content';
import type { couponPages, ThemeAccountCouponsView } from '@storeweave/coupon';
import type { customerPages, ThemeAccountProfileView } from '@storeweave/customer';
import type { createLoyaltyPages, ThemeAccountRewardsView } from '@storeweave/loyalty';
import type { orderPages, ThemeAccountOrdersView, ThemeOrderView } from '@storeweave/order';
import { csrfField, escapeHtml, formatMoney, layout } from './layout';
import { formatDate, formatDateTime, safeUrlAttribute } from '@storeweave/i18n';
import { EDITORIAL_IMAGE_KEYS, renderStorefrontArtwork, renderWovenDayEditorialImage, renderWovenDayProductImage, type WovenDayEditorialImage } from './artwork';

type AccountSection = 'orders' | 'coupons' | 'rewards' | 'profile';

/**
 * 文章卡片、內文與新聞列共用的最小形狀。首頁摘要（`ThemeHomeView` 的
 * `story`／`journal`／`news`）與品牌內容頁（`ThemeArticleView`）的 `kind`
 * 型別不同——前者是字串，後者是字面量聯集——但這幾個 helper 都沒用到
 * `kind`，用它當交集會讓兩種來源都能直接傳進來。
 */
type ArticleLike = {
  kind: string;
  slug: string;
  title: string;
  summary: string;
  section: string;
  body: { heading: string | null; text: string }[];
  imageKey: string | null;
  publishedAt: Date | null;
};

function feedback(message: string | null | undefined, tone: 'notice' | 'error' = 'notice'): string {
  if (!message) return '';
  return `<div class="${tone}" role="${tone === 'error' ? 'alert' : 'status'}"><p>${escapeHtml(message)}</p></div>`;
}

function pageHeading(eyebrow: string, title: string, description?: string): string {
  return `<header class="page-heading">
    <p class="eyebrow">${escapeHtml(eyebrow)}</p>
    <h1>${escapeHtml(title)}</h1>
    ${description ? `<p class="page-heading__copy">${escapeHtml(description)}</p>` : ''}
  </header>`;
}

function accountIntro(current: AccountSection, title: string, description: string): string {
  const sections: { id: AccountSection; href: string; label: string }[] = [
    { id: 'orders', href: '/account/orders', label: '我的訂單' },
    { id: 'coupons', href: '/account/coupons', label: '我的券' },
    { id: 'rewards', href: '/account/rewards', label: '購物金' },
    { id: 'profile', href: '/account/profile', label: '個人資料' },
  ];
  const links = sections.map((section) =>
    `<a href="${section.href}"${section.id === current ? ' aria-current="page"' : ''}>${section.label}</a>`,
  ).join('');

  return `<header class="account-intro">
    <div>
      <p class="eyebrow">會員中心</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="page-heading__copy">${escapeHtml(description)}</p>
    </div>
    <nav class="account-tabs" aria-label="會員中心導覽">${links}</nav>
  </header>`;
}

function orderStatus(status: string): string {
  const labels: Record<string, string> = {
    pending: '訂單已建立',
    payment_processing: '付款處理中',
    awaiting_payment: '等待付款',
    paid: '付款完成',
    expired: '已逾時',
    cancelled: '已取消',
  };
  const label = Object.hasOwn(labels, status) ? labels[status] : status;
  return `<span class="order-status" data-status="${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

/** Shipment's domain stage is stable, but the customer copy must not be an internal enum. */
function shipmentStatus(status: NonNullable<ThemeOrderView['shipment']>['status']): string {
  const labels: Record<NonNullable<ThemeOrderView['shipment']>['status'], string> = {
    created: '物流單已建立',
    shipped: '已出貨',
    arrived: '已到店／送達',
    completed: '配送完成',
  };
  return labels[status];
}

function rmaStatus(status: ThemeOrderView['rmas'][number]['status']): string {
  const labels: Record<ThemeOrderView['rmas'][number]['status'], string> = {
    requested: '已提出申請',
    needs_information: '待補充資料',
    approved: '已核准，等待收件',
    rejected: '未核准',
    received: '已收件，等待退款處理',
    refund_pending: '退款處理中',
    refund_failed: '退款處理失敗，客服將協助處理',
    completed: '案件已完成',
  };
  return labels[status];
}

/** Payment providers may return a hosted page, but never get to choose an executable URL scheme. */
function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function catalogUrl(q: string, minPrice: number | null, maxPrice: number | null, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (minPrice !== null) params.set('minPrice', String(minPrice));
  if (maxPrice !== null) params.set('maxPrice', String(maxPrice));
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

function paymentContinuation(payment: NonNullable<ThemeOrderView['payment']>): string {
  if ((payment.status !== 'submitted' && payment.status !== 'awaiting_payment') || !payment.action) return '';
  const url = safeExternalUrl(payment.action.url);
  if (!url) return feedback('付款連結無效，請聯絡客服協助。', 'error');

  if (payment.action.type === 'redirect') {
    return `<section class="checkout-submit" aria-label="繼續付款">
      <p>付款頁面已準備完成，請主動前往繼續付款。</p>
      <a class="cta" href="${safeUrlAttribute(url)}" rel="noopener noreferrer">前往付款</a>
    </section>`;
  }

  const fields = Object.entries(payment.action.fields)
    .filter(([name]) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
  return `<section class="checkout-submit" aria-label="繼續付款">
    <p>付款資料已準備完成，請主動前往付款頁面。</p>
    <form method="post" action="${escapeHtml(url)}">
      ${fields}
      <button type="submit">前往付款</button>
    </form>
  </section>`;
}

/** 忘記密碼與重設密碼：兩張表單長得夠像，共用一支。 */
function renderPasswordForm(
  ctx: ThemeContext,
  view: Extract<ThemeAuthView, { mode: 'forgot-password' | 'reset-password' }>,
): string {
  const forgot = view.mode === 'forgot-password';
  const error = view.error;
  const notice = forgot ? view.notice : undefined;
  const token = forgot ? undefined : view.token;
  const body = `
    <article class="auth-page">
      <section class="auth-card" aria-labelledby="auth-title">
        <div class="auth-card__header">
          <p class="eyebrow">帳戶存取</p>
          <h1 id="auth-title">${forgot ? '忘記密碼' : '設定新密碼'}</h1>
          <p class="page-heading__copy">${forgot
            ? '輸入帳戶電子郵件，我們會寄送設定新密碼的連結。'
            : '請設定至少八個字元的新密碼。'}</p>
        </div>
        ${feedback(notice)}
        ${feedback(error, 'error')}
        ${notice && forgot ? '' : `<form class="auth-form" method="post" action="${forgot ? '/forgot-password' : '/reset-password'}">
          ${forgot
            ? `<label>電子郵件<input type="email" name="email" required placeholder="you@example.com" autocomplete="email"></label>`
            : `<input type="hidden" name="token" value="${escapeHtml(token ?? '')}">
               <label>新密碼<input type="password" name="password" required minlength="8" autocomplete="new-password"></label>`}
          <button type="submit">${forgot ? '寄出重設連結' : '設定新密碼'}</button>
        </form>`}
        <p class="auth-card__footer"><a href="/login">回登入</a></p>
      </section>
    </article>`;
  return layout({ title: forgot ? '忘記密碼' : '設定新密碼', body, ctx });
}

/**
 * 購物車與確認頁的商品表。`editable` 決定要不要出現數量與移除的表單——
 * 確認頁刻意不能改，否則「確認的內容」與「結出來的單」會是兩份東西。
 */
function cartTable(ctx: ThemeContext, view: ThemeCartView, editable: boolean): string {
  const money = (cents: number) => formatMoney(cents, view.currency, ctx.locale);
  const rows = view.lines.map((line, index) => {
    const quantityId = `cart-quantity-${index}`;
    const availability = line.available === null
      ? ''
      : line.available > 0 ? `目前可售 ${line.available} 件` : '目前已售完';
    return `
      <tr class="cart-table__line">
        <td class="cart-table__product" data-label="商品">
          <a class="cart-table__product-name" href="/p/${escapeHtml(line.productId)}">${escapeHtml(line.name)}</a>
          ${ctx.options.showSku !== false ? `<p class="cart-table__sku">${escapeHtml(line.sku)}</p>` : ''}
          ${availability ? `<p class="cart-table__availability${line.available !== null && line.available <= 0 ? ' cart-table__availability--unavailable' : ''}">${availability}</p>` : ''}
        </td>
        <td data-label="單價">${money(line.unitPriceCents)}</td>
        <td class="cart-table__quantity" data-label="數量">${editable ? `
          <form method="post" action="/cart/items/${escapeHtml(line.productId)}" class="inline cart-quantity-form">
            ${csrfField(ctx)}
            <label class="sr-only" for="${quantityId}">${escapeHtml(line.name)} 的數量</label>
            <input id="${quantityId}" type="number" name="quantity" value="${line.quantity}" min="0"${line.available === null ? '' : ` max="${line.available}"`} required>
            <button type="submit">更新</button>
          </form>` : line.quantity}</td>
        <td data-label="小計">${money(line.lineTotalCents)}</td>
        <td data-label="折扣">${line.discountCents > 0 ? `−${money(line.discountCents)}` : '—'}</td>
        <td class="cart-table__net" data-label="實付">${money(line.netCents)}</td>
        ${editable ? `<td class="cart-table__remove" data-label="操作">
          <form method="post" action="/cart/items/${escapeHtml(line.productId)}" class="inline">
            ${csrfField(ctx)}
            <input type="hidden" name="quantity" value="0">
            <button type="submit" class="linklike" aria-label="移除 ${escapeHtml(line.name)}">移除</button>
          </form>
        </td>` : ''}
      </tr>`;
  }).join('');

  return `
    <table class="cart-table">
      <caption class="sr-only">${editable ? '購物車中的商品' : '即將建立的訂單商品'}</caption>
      <thead><tr>
        <th scope="col">商品</th><th scope="col">單價</th><th scope="col">數量</th><th scope="col">小計</th><th scope="col">折扣</th><th scope="col">實付</th>${editable ? '<th scope="col">操作</th>' : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function cartSummary(
  ctx: ThemeContext,
  view: ThemeCartView,
  id: string,
  heading: string,
  totalLabel: string,
): string {
  const money = (cents: number) => formatMoney(cents, view.currency, ctx.locale);
  const adjustments = view.adjustments.map((adjustment) => `
    <div class="order-summary__row"><dt>${escapeHtml(adjustment.name)}</dt><dd>${money(adjustment.amountCents)}</dd></div>`).join('');
  return `<section class="order-summary" aria-labelledby="${id}">
    <h2 id="${id}">${escapeHtml(heading)}</h2>
    <dl>
      <div class="order-summary__row"><dt>商品小計</dt><dd>${money(view.subtotalCents)}</dd></div>
      ${adjustments}
      <div class="order-summary__row order-summary__row--total"><dt>${escapeHtml(totalLabel)}</dt><dd>${money(view.totalCents)}</dd></div>
    </dl>
  </section>`;
}

/** Checkout adds a server-quoted shipping fee to the server-derived cart amount. */
function checkoutSummary(ctx: ThemeContext, view: ThemeCheckoutView): string {
  const money = (cents: number) => formatMoney(cents, view.currency, ctx.locale);
  const adjustments = view.adjustments.map((adjustment) => `
    <div class="order-summary__row"><dt>${escapeHtml(adjustment.name)}</dt><dd>${money(adjustment.amountCents)}</dd></div>`).join('');
  return `<section class="order-summary" aria-labelledby="checkout-summary-title">
    <h2 id="checkout-summary-title">訂單摘要</h2>
    <dl>
      <div class="order-summary__row"><dt>商品小計</dt><dd>${money(view.subtotalCents)}</dd></div>
      ${adjustments}
      <div class="order-summary__row"><dt>商品與折扣小計</dt><dd>${money(view.totalCents)}</dd></div>
      <div class="order-summary__row"><dt>運費</dt><dd>${money(view.shippingPreview.shippingCents)}</dd></div>
      <div class="order-summary__row order-summary__row--total"><dt>含運費總額</dt><dd>${money(view.shippingPreview.totalCents)}</dd></div>
    </dl>
  </section>`;
}

/**
 * 折扣碼的輸入與移除。套用中的碼顯示成「已套用 + 移除」，
 * 而不是把輸入框清空——顧客要看得到自己現在用的是哪一組。
 */
function couponBox(ctx: ThemeContext, view: ThemeCartView): string {
  if (view.coupon) {
    return `
      <section class="cart-option" aria-labelledby="coupon-title">
        <h2 id="coupon-title">優惠碼</h2>
        <p>已套用折扣碼 <strong>${escapeHtml(view.coupon.code)}</strong>
           ${view.coupon.discountCents > 0
             ? `（折 ${formatMoney(view.coupon.discountCents, view.currency, ctx.locale)}）`
             : '（目前不符合條件，金額沒有變化）'}</p>
        <form method="post" action="/cart/coupon" class="inline">
          ${csrfField(ctx)}
          <input type="hidden" name="remove" value="1">
          <button type="submit" class="linklike">移除</button>
        </form>
      </section>`;
  }
  return `
    <section class="cart-option" aria-labelledby="coupon-title">
      <h2 id="coupon-title">優惠碼</h2>
      ${feedback(view.couponError, 'error')}
      <form method="post" action="/cart/coupon" class="inline cart-option__form">
        ${csrfField(ctx)}
        <label>折扣碼<input name="code" maxlength="40" placeholder="輸入折扣碼"></label>
        <button type="submit">套用</button>
      </form>
    </section>`;
}

/** 買不到的商品被拿掉時要講出來，而且要在結帳之前。 */
function removedNotice(view: ThemeCartView): string {
  if (view.removedNames.length === 0) return '';
  return `<div class="notice" role="status"><p>這些商品已經買不到，已從購物車移除：${
    view.removedNames.map((name) => escapeHtml(name)).join('、')}。</p></div>`;
}

/**
 * 購物金折抵。訪客沒有帳本，因此只對會員顯示；餘額是零時也不顯示——
 * 給一個永遠只能填 0 的輸入框只是雜訊。
 */
function rewardBox(ctx: ThemeContext, view: ThemeCartView): string {
  const reward = view.reward;
  if (!reward || (reward.availableCents <= 0 && reward.appliedCents <= 0)) return '';
  const money = (cents: number) => formatMoney(cents, view.currency, ctx.locale);
  const shortfall = reward.requestedCents > reward.appliedCents;

  return `
    <section class="cart-option" aria-labelledby="reward-title">
      <h2 id="reward-title">購物金折抵</h2>
      <p>可用購物金 <strong>${money(reward.availableCents)}</strong>，這次最多可折 ${money(reward.maxCents)}。</p>
      ${shortfall
        ? `<p class="muted">你要求折 ${money(reward.requestedCents)}，這次只折得了 ${money(reward.appliedCents)}。</p>`
        : ''}
      <form method="post" action="/cart/rewards" class="inline cart-option__form">
        ${csrfField(ctx)}
        <label>折抵金額（元）
          <input type="number" name="amount" step="0.01" min="0" max="${(reward.maxCents / 100).toFixed(2)}"
                 value="${(reward.appliedCents / 100).toFixed(2)}">
        </label>
        <button type="submit">套用</button>
      </form>
    </section>`;
}

/** 門檻活動唯一的行銷價值就是這句話：還差多少。 */
function thresholdHint(ctx: ThemeContext, view: ThemeCartView): string {
  if (!view.nextThreshold) return '';
  const amount = formatMoney(view.nextThreshold.remainingCents, view.currency, ctx.locale);
  return `<div class="notice" role="status"><p>再買 ${amount} 就達到「${escapeHtml(view.nextThreshold.name)}」。</p></div>`;
}

/**
 * 券的狀態。即將到期要說得出來——顧客沒用掉的券，多半是因為忘了它存在。
 * 不能用時說出真正的原因：全部寫「已過期」會讓顧客去找別張，而問題其實是活動停掉了。
 */
const UNUSABLE_TEXT: Record<NonNullable<ThemeAccountCouponsView['coupons'][number]['unusableReason']>, string> = {
  used: '已使用',
  void: '已停用',
  not_started: '尚未開始',
  expired: '已過期',
  promotion_ended: '活動已結束',
};

function couponStateText(coupon: ThemeAccountCouponsView['coupons'][number]): string {
  // hasOwn 而不是直接索引：`constructor` 這種鍵會取到 Object.prototype 上的東西。
  if (coupon.unusableReason && Object.hasOwn(UNUSABLE_TEXT, coupon.unusableReason)) {
    return `<span class="badge">${UNUSABLE_TEXT[coupon.unusableReason]}</span>`;
  }
  if (coupon.unusableReason) return '<span class="badge">目前不可使用</span>';
  return coupon.expiringSoon ? '<span class="badge expiring">即將到期</span>' : '<span class="badge">可使用</span>';
}

function productCard(ctx: ThemeContext, product: ThemeCatalogView['products'][number]): string {
  const soldOut = product.available !== null && product.available <= 0;
  const availability = product.available === null
    ? ''
    : product.available > 0 ? `可售 ${product.available} 件` : '已售完';
  return `<article class="product-card">
    <div class="product-card__art">${isWovenDay(ctx) ? renderWovenDayProductImage(product.sku) : renderStorefrontArtwork(product.id)}</div>
    <a class="product-card__link" href="/p/${escapeHtml(product.id)}" aria-label="${escapeHtml(product.name)} 的商品詳情">
      <div class="product-card__content">
        ${ctx.options.showSku !== false ? `<p class="product-card__sku">${escapeHtml(product.sku)}</p>` : ''}
        <h2>${escapeHtml(product.name)}</h2>
        ${product.description ? `<p class="product-card__description">${escapeHtml(product.description)}</p>` : ''}
      </div>
      <div class="product-card__footer">
        <p class="price">${formatMoney(product.priceCents, product.currency, ctx.locale)}</p>
        ${availability ? `<p class="product-card__availability${soldOut ? ' product-card__availability--sold-out' : ''}">${availability}</p>` : ''}
      </div>
    </a>
  </article>`;
}

function isWovenDay(ctx: ThemeContext): boolean {
  return ctx.storeId === 'example-store';
}

/**
 * An article names a theme-owned photograph by key (ADR 0034). A key this theme
 * no longer ships renders as no image at all: a missing photo must not take the
 * page down with it.
 */
function editorialImage(article: ArticleLike, loading: 'eager' | 'lazy' = 'lazy'): string {
  const key = article.imageKey;
  if (!key || !EDITORIAL_IMAGE_KEYS.includes(key as WovenDayEditorialImage)) return '';
  return renderWovenDayEditorialImage(key as WovenDayEditorialImage, loading);
}

/** Blocks with a heading are story chapters; everything else is a plain paragraph. */
function articleBody(article: ArticleLike): string {
  return article.body.map((block) => (block.heading
    ? `<section class="article-block"><h2>${escapeHtml(block.heading)}</h2><p>${escapeHtml(block.text)}</p></section>`
    : `<p>${escapeHtml(block.text)}</p>`)).join('');
}

/** News reads as a dated notice list, not a photo grid: the date is the point. */
function newsRow(article: ArticleLike): string {
  const href = `/news/${escapeHtml(article.slug)}`;
  const date = article.publishedAt
    ? `<time datetime="${article.publishedAt.toISOString().slice(0, 10)}">${article.publishedAt.toISOString().slice(0, 10)}</time>`
    : '';
  return `<li class="news-row">
    ${date}
    <div class="news-row__copy">
      ${article.section ? `<p class="news-row__meta">${escapeHtml(article.section)}</p>` : ''}
      <h3><a href="${href}">${escapeHtml(article.title)}</a></h3>
      ${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ''}
    </div>
  </li>`;
}

function articleCard(article: ArticleLike, base: string): string {
  const href = `${base}/${escapeHtml(article.slug)}`;
  const cover = editorialImage(article);
  return `<article class="journal-card">
    ${cover ? `<a href="${href}" class="journal-card__cover-wrap" aria-label="閱讀：${escapeHtml(article.title)}">${cover}</a>` : ''}
    <div class="journal-card__body">
      ${article.section ? `<p class="journal-card__meta">${escapeHtml(article.section)}</p>` : ''}
      <h3><a href="${href}">${escapeHtml(article.title)}</a></h3>
      ${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ''}
      <a class="journal-card__read" href="${href}">閱讀全文 <span aria-hidden="true">→</span></a>
    </div>
  </article>`;
}

/** Shared by the journal and news reading pages; only the breadcrumb differs. */
function articlePage(ctx: ThemeContext, article: ThemeArticleView, base: string, listLabel: string): string {
  const cover = editorialImage(article, 'eager');
  const body = `
    <article class="journal-article-page">
      <nav class="breadcrumb" aria-label="麵包屑"><a href="/">首頁</a><span aria-hidden="true"> / </span><a href="${base}">${escapeHtml(listLabel)}</a><span aria-hidden="true"> / </span><span>${escapeHtml(article.title)}</span></nav>
      <header class="article-header">${article.section ? `<p class="eyebrow">${escapeHtml(article.section)}</p>` : ''}<h1>${escapeHtml(article.title)}</h1>${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ''}</header>
      ${cover ? `<div class="article-hero-art">${cover}</div>` : ''}
      <div class="article-content">${articleBody(article)}</div>
      <p class="article-return"><a class="secondary-action" href="${base}">回到${escapeHtml(listLabel)}</a></p>
    </article>`;
  return layout({ title: article.title, body, ctx });
}

/**
 * 這個 Theme 專屬的視覺設定。標語不在這裡：它換 theme 之後應該還在，
 * 所以存在 `platform_site_settings`（ADR 0046）。
 */
export const defaultThemeOptions = z.object({
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8C3E28'),
  showSku: z.boolean().default(true),
});

export function renderHome(ctx: ThemeContext, { products, q, minPrice, maxPrice, page, pageSize, total, story, journal, news }: ThemeHomeView): string {
  const isFilteredOrPaged = Boolean(q) || minPrice !== null || maxPrice !== null || page > 1;

  // 若使用者帶有篩選條件或分頁，直接呈現目錄模式
  if (isFilteredOrPaged) {
    return renderCatalog(ctx, { products, q, minPrice, maxPrice, page, pageSize, total });
  }

    const featuredCards = products.slice(0, 6).map((product) => productCard(ctx, product)).join('');
    const productCount = total === 1 ? '目前有 1 件商品可瀏覽。' : `目前有 ${total} 件商品可瀏覽。`;
    const branded = isWovenDay(ctx);

    const heroSection = `
      <section class="storefront-hero" aria-labelledby="hero-title">
        <div class="storefront-hero__copy">
          <p class="eyebrow">${escapeHtml(story?.section || ctx.storeName)}</p>
          <h1 id="hero-title">${escapeHtml(story?.title ?? '為日常，留下一點餘裕。')}</h1>
          <p>${escapeHtml(story?.summary ?? '從正在販售的商品開始，找到適合你的選擇。')}${productCount}</p>
          <a class="cta" href="/catalog">瀏覽商品</a>
        </div>
        <div class="storefront-hero__art">${branded ? renderWovenDayEditorialImage('hero', 'eager') : renderStorefrontArtwork(ctx.storeId, 'hero')}</div>
      </section>`;

    const chapters = story?.body.filter((block) => block.heading) ?? [];
    const brandSection = story ? `
      <section class="brand-manifesto" aria-labelledby="brand-manifesto-title">
        <div class="brand-manifesto__copy">
          <p class="eyebrow">我們相信</p>
          <!--
            標題不重複 hero 的那一句：兩者讀的是同一篇品牌故事，
            把 story.title 印兩次會讓首頁看起來像壞掉。
          -->
          <h2 id="brand-manifesto-title">選物的那幾件事</h2>
          <p>${escapeHtml(story.summary)}</p>
          <a class="secondary-action" href="/story">閱讀品牌故事</a>
        </div>
        ${chapters.length ? `<ol class="brand-manifesto__chapters">
          ${chapters.map((chapter, index) => `<li>
            <span>${String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(chapter.heading!)}</h3><p>${escapeHtml(chapter.text)}</p>
          </li>`).join('')}
        </ol>` : ''}
      </section>` : '';

    const newsSection = news.length ? `
      <section class="storefront-news" aria-labelledby="news-title">
        <div class="catalog-section__header">
          <div><p class="eyebrow">店務公告</p><h2 id="news-title">最新消息</h2></div>
          <a class="secondary-action" href="/news">查看全部消息</a>
        </div>
        <ul class="news-list news-list--compact">${news.map(newsRow).join('')}</ul>
      </section>` : '';

    const journalSection = journal.length ? `
      <section class="journal-section storefront-journal" aria-labelledby="journal-title">
        <div class="catalog-section__header">
          <div><p class="eyebrow">Woven Journal</p><h2 id="journal-title">為生活留下的筆記</h2></div>
          <a class="secondary-action" href="/journal">閱讀全部文章</a>
        </div>
        <div class="journal-grid">${journal.map((article) => articleCard(article, '/journal')).join('')}</div>
      </section>` : '';

    const discoverySection = `
      <section class="storefront-discovery" aria-labelledby="discovery-title">
        <div class="storefront-discovery__art">${branded ? renderWovenDayEditorialImage('story') : renderStorefrontArtwork(`${ctx.storeId}-catalog`, 'hero')}</div>
        <div class="storefront-discovery__copy">
          <p class="eyebrow">從需求開始</p>
          <h2 id="discovery-title">把瀏覽留給商品本身。</h2>
          <p>完整型錄支援以商品名稱、SKU 與價格範圍搜尋；每一筆結果都直接連到商品詳情頁。</p>
          <a class="secondary-action" href="/catalog">前往商品型錄</a>
        </div>
      </section>`;

    const journeySection = `
      <section class="storefront-journey" aria-labelledby="journey-title">
        <div class="storefront-journey__heading">
          <p class="eyebrow">購物流程</p>
          <h2 id="journey-title">清楚地挑選，安心地確認。</h2>
        </div>
        <ol class="storefront-journey__steps">
          <li><span>01</span><h3>瀏覽商品</h3><p>從目前上架的商品中開始探索。</p></li>
          <li><span>02</span><h3>加入購物車</h3><p>依商品可售狀態選擇數量。</p></li>
          <li><span>03</span><h3>核對結帳</h3><p>建立訂單前再次確認價格與可售狀態。</p></li>
        </ol>
      </section>`;

    const featuredSection = `
      <section class="catalog-section" aria-labelledby="featured-title">
        <div class="catalog-section__header">
          <div>
            <p class="eyebrow">商品瀏覽</p>
            <h2 id="featured-title">正在販售的商品</h2>
          </div>
          <a class="secondary-action" href="/catalog">查看全部商品</a>
        </div>
        ${featuredCards ? `<div class="catalog-grid">${featuredCards}</div>` : '<p class="empty-state">目前沒有上架的商品。</p>'}
      </section>`;

    const body = `
      <div class="catalog-page">
        ${heroSection}
        ${brandSection}
        ${newsSection}
        ${featuredSection}
        ${discoverySection}
        ${journalSection}
        ${journeySection}
      </div>`;
    return layout({ title: '首頁', body, ctx });
}

export function renderCatalog(ctx: ThemeContext, { products, q, minPrice, maxPrice, page, pageSize, total }: ThemeCatalogView): string {
    const cards = products.map((product) => productCard(ctx, product)).join('');

    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const outOfRange = total > 0 && page > pageCount;
    const hasFilters = Boolean(q) || minPrice !== null || maxPrice !== null;
    const heading = q ? `搜尋「${escapeHtml(q)}」` : '選物全目錄';
    const empty = outOfRange
      ? `<p class="empty-state">第 ${page} 頁沒有商品。<a href="${escapeHtml(catalogUrl(q, minPrice, maxPrice, 1))}">回到第一頁</a></p>`
      : hasFilters ? '<p class="empty-state">找不到符合目前篩選條件的商品。</p>' : '<p class="empty-state">目前沒有上架的商品。</p>';
    const pagination = pageCount > 1 ? `<nav class="catalog-pagination" aria-label="商品分頁">
      ${page > 1 ? `<a href="${escapeHtml(catalogUrl(q, minPrice, maxPrice, page - 1))}" rel="prev">上一頁</a>` : '<span aria-hidden="true">上一頁</span>'}
      <span>第 ${page}／${pageCount} 頁</span>
      ${page < pageCount ? `<a href="${escapeHtml(catalogUrl(q, minPrice, maxPrice, page + 1))}" rel="next">下一頁</a>` : '<span aria-hidden="true">下一頁</span>'}
    </nav>` : '';

    const body = `
      <div class="catalog-page">
        <header class="page-heading">
          <p class="eyebrow">商品型錄 · ${escapeHtml(ctx.storeName)}</p>
          <h1>${heading}</h1>
          <p class="page-heading__copy">依商品名稱、SKU 或價格範圍找到正在販售的商品。</p>
        </header>
        <section class="catalog-section" aria-labelledby="catalog-products-heading">
          <form class="catalog-search" method="get" action="/catalog" role="search">
            <label for="catalog-query">商品名稱或 SKU</label>
            <input id="catalog-query" type="search" name="q" value="${escapeHtml(q)}" maxlength="200" autocomplete="off">
            <label for="catalog-min-price">最低價格（元）</label>
            <input id="catalog-min-price" type="number" name="minPrice" value="${minPrice ?? ''}" min="0" step="1" inputmode="numeric">
            <label for="catalog-max-price">最高價格（元）</label>
            <input id="catalog-max-price" type="number" name="maxPrice" value="${maxPrice ?? ''}" min="0" step="1" inputmode="numeric">
            <button type="submit">搜尋</button>
          </form>
          ${products.length
            ? `<div class="catalog-grid">${cards}</div>`
            : empty}
          ${pagination}
        </section>
      </div>`;
    return layout({ title: '選物目錄', body, ctx });
}

export function renderStory(ctx: ThemeContext, { article }: { article: ThemeArticleView }): string {
    const cover = editorialImage(article, 'eager');
    const chapters = article.body.filter((block) => block.heading);
    const paragraphs = article.body.filter((block) => !block.heading);
    const body = `
      <article class="brand-story-page">
        <header class="brand-story-hero">
          <div>${article.section ? `<p class="eyebrow">${escapeHtml(article.section)}</p>` : ''}<h1>${escapeHtml(article.title)}</h1>${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ''}</div>
          ${cover ? `<div class="brand-story-hero__art">${cover}</div>` : ''}
        </header>
        ${paragraphs.length ? `<section class="brand-story-lead">${paragraphs.map((block) => `<p>${escapeHtml(block.text)}</p>`).join('')}</section>` : ''}
        ${chapters.length ? `<section class="brand-story-chapters" aria-label="選物觀點">
          ${chapters.map((chapter, index) => `<article>
            <p class="eyebrow">${String(index + 1).padStart(2, '0')}</p><h2>${escapeHtml(chapter.heading!)}</h2><p>${escapeHtml(chapter.text)}</p>
          </article>`).join('')}
        </section>` : ''}
        <section class="brand-story-closing">
          <p class="eyebrow">選物從使用開始</p><h2>把真正會回到手邊的，留在生活裡。</h2><a class="cta" href="/catalog">瀏覽商品型錄</a>
        </section>
      </article>`;
    return layout({ title: article.title, body, ctx });
}

export function renderJournalList(ctx: ThemeContext, { articles }: ThemeArticleListView): string {
  const body = `
      <article class="journal-page">
        <header class="page-heading"><p class="eyebrow">Woven Journal</p><h1>生活誌</h1><p class="page-heading__copy">記下物件、空間與日常之間，慢慢形成的關係。</p></header>
        <section class="journal-grid journal-grid--three" aria-label="生活誌文章">${articles.map((article) => articleCard(article, '/journal')).join('')}</section>
      </article>`;
  return layout({ title: '生活誌', body, ctx });
}

export function renderJournalArticle(ctx: ThemeContext, { article }: { article: ThemeArticleView }): string {
  return articlePage(ctx, article, '/journal', '生活誌');
}

export function renderNewsList(ctx: ThemeContext, { articles }: ThemeArticleListView): string {
  const body = `
      <article class="news-page">
        <header class="page-heading"><p class="eyebrow">店務公告</p><h1>最新消息</h1><p class="page-heading__copy">出貨安排、活動與服務調整，都會先公布在這裡。</p></header>
        <ul class="news-list" aria-label="最新消息">${articles.map(newsRow).join('')}</ul>
      </article>`;
  return layout({ title: '最新消息', body, ctx });
}

export function renderNewsArticle(ctx: ThemeContext, { article }: { article: ThemeArticleView }): string {
  return articlePage(ctx, article, '/news', '最新消息');
}

export function renderFaq(ctx: ThemeContext, { articles }: ThemeArticleListView): string {
    // Grouped by the merchant's own section labels; ungrouped entries keep their order.
    const groups = new Map<string, ThemeArticleView[]>();
    for (const article of articles) {
      const key = article.section || '';
      groups.set(key, [...(groups.get(key) ?? []), article]);
    }
    const body = `
      <article class="faq-page">
        <header class="page-heading"><p class="eyebrow">常見問題</p><h1>需要協助嗎？</h1><p class="page-heading__copy">這裡整理了訂購、付款、出貨與退換貨最常被問到的問題。</p></header>
        ${[...groups].map(([section, entries]) => `<section class="faq-group" ${section ? `aria-label="${escapeHtml(section)}"` : 'aria-label="常見問題"'}>
          ${section ? `<h2 class="faq-group__title">${escapeHtml(section)}</h2>` : ''}
          <dl class="faq-list">${entries.map((entry) => `
            <div class="faq-item">
              <dt>${escapeHtml(entry.title)}</dt>
              <dd>${entry.summary ? `<p>${escapeHtml(entry.summary)}</p>` : ''}${articleBody(entry)}</dd>
            </div>`).join('')}</dl>
        </section>`).join('')}
        <section class="faq-closing">
          <p>沒有找到答案？<a href="/contact">寫訊息給我們</a>，我們會盡快回覆。</p>
        </section>
      </article>`;
    return layout({ title: '常見問題', body, ctx });
}

export function renderContact(ctx: ThemeContext, { submitted, values, error }: ThemeContactView): string {
    const csrf = csrfField(ctx);
    const support = ctx.supportEmail
      ? `<p class="contact-support">也可以直接寫信到 <a href="mailto:${escapeHtml(ctx.supportEmail)}">${escapeHtml(ctx.supportEmail)}</a>。</p>`
      : '';
    const form = `
      <form class="contact-form" method="post" action="/contact">
        ${csrf}
        ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
        <label class="field"><span>姓名</span><input name="name" required maxlength="80" value="${escapeHtml(values.name)}"></label>
        <label class="field"><span>電子郵件</span><input type="email" name="email" required maxlength="320" value="${escapeHtml(values.email)}"></label>
        <label class="field"><span>主旨</span><input name="subject" required maxlength="200" value="${escapeHtml(values.subject)}"></label>
        <label class="field"><span>訊息內容</span><textarea name="message" required rows="8" maxlength="4000">${escapeHtml(values.message)}</textarea></label>
        <p class="contact-hp"><label aria-hidden="true">請不要填寫這個欄位<input name="website" type="text" tabindex="-1" autocomplete="off"></label></p>
        <button class="cta" type="submit">送出訊息</button>
      </form>`;
    const body = `
      <article class="contact-page">
        <header class="page-heading"><p class="eyebrow">聯絡我們</p><h1>有問題想問嗎？</h1><p class="page-heading__copy">留下訊息，我們會在營業日內回覆。</p></header>
        ${submitted
          ? `<section class="contact-done"><h2>訊息已送出</h2><p>謝謝你的來信，我們收到了，會盡快回覆到你留下的信箱。</p><a class="secondary-action" href="/">回到首頁</a></section>`
          : form}
        ${support}
      </article>`;
    return layout({ title: '聯絡我們', body, ctx });
}

export function renderProduct(ctx: ThemeContext, { product }: { product: ThemeProductView }): string {
    const soldOut = product.available !== null && product.available <= 0;
    const availability = product.available === null
      ? ''
      : product.available > 0 ? `可售 ${product.available} 件` : '已售完';
    const body = `
      <article class="product-page">
        <nav class="breadcrumb" aria-label="麵包屑">
          <a href="/">首頁</a><span aria-hidden="true"> / </span><a href="/catalog">商品型錄</a><span aria-hidden="true"> / </span><span>${escapeHtml(product.name)}</span>
        </nav>
        <div class="product-detail">
          <section class="product-detail__content">
            <div class="product-artwork">${isWovenDay(ctx) ? renderWovenDayProductImage(product.sku, 'hero') : renderStorefrontArtwork(product.id, 'hero')}</div>
            <div>
              <p class="eyebrow">商品詳情 · ${escapeHtml(ctx.storeName)}</p>
              <h1>${escapeHtml(product.name)}</h1>
              ${ctx.options.showSku !== false ? `<p class="product-detail__sku">${escapeHtml(product.sku)}</p>` : ''}
            </div>
            ${product.description ? `<p class="product-detail__description">${escapeHtml(product.description)}</p>` : ''}
          </section>
          <aside class="product-purchase" aria-label="${escapeHtml(product.name)} 的購買資訊">
            <p class="product-purchase__label">商品價格</p>
            <p class="price">${formatMoney(product.priceCents, product.currency, ctx.locale)}</p>
            ${availability ? `<p class="product-purchase__availability${soldOut ? ' product-purchase__availability--sold-out' : ''}">${availability}</p>` : ''}
            ${soldOut
              ? '<p class="product-form__hint">目前已售完，暫時無法加入購物車。</p>'
              : `<form class="product-form" method="post" action="/cart/items">
                  <input type="hidden" name="productId" value="${escapeHtml(product.id)}">
                  ${csrfField(ctx)}
                  <label>數量
                    <input type="number" name="quantity" value="1" min="1"${product.available === null ? '' : ` max="${product.available}"`} required>
                  </label>
                  ${product.available === null ? '<p class="product-form__hint">數量將由系統於加入購物車時確認。</p>' : ''}
                  <button type="submit">加入購物車</button>
                </form>`}
            <p class="product-purchase__note">價格與可售狀態會在加入購物車與建立訂單前再次確認。</p>
          </aside>
        </div>
      </article>`;
    return layout({ title: product.name, body, ctx });
}

export function renderCart(ctx: ThemeContext, view: ThemeCartView): string {
    const body = `
      <article class="cart-page">
        ${pageHeading('購物流程', '購物車', '價格與可售狀態會在建立訂單前再次確認。')}
        ${feedback(view.error, 'error')}
        ${removedNotice(view)}
        ${view.lines.length === 0
          ? `<section class="empty-state empty-state--cart" aria-labelledby="empty-cart-title">
              <p class="eyebrow">尚未選購</p>
              <h2 id="empty-cart-title">購物車是空的</h2>
              <p>挑選商品後，它們會出現在這裡。</p>
              <a class="cta" href="/">返回商品列表</a>
            </section>`
          : `<div class="cart-layout">
              <section class="cart-content" aria-labelledby="cart-items-title">
                <div class="section-heading">
                  <h2 id="cart-items-title">已選商品</h2>
                  <p>${view.lines.length} 項商品</p>
                </div>
                ${cartTable(ctx, view, true)}
                ${thresholdHint(ctx, view)}
                ${couponBox(ctx, view)}
                ${rewardBox(ctx, view)}
              </section>
              <aside class="cart-sidebar" aria-label="購物車摘要">
                ${cartSummary(ctx, view, 'cart-summary-title', '訂單摘要', '預估總額')}
                <a class="cta cart-sidebar__cta" href="/checkout">${ctx.customerName ? '前往結帳' : '登入後結帳'}</a>
                <p class="cart-sidebar__note">${ctx.customerName
                  ? '建立訂單前，請再次確認品項與總額。'
                  : '結帳前會先請你登入或註冊。'}</p>
                <div class="cart-actions">
                  <a href="/">繼續購物</a>
                  <form method="post" action="/cart/clear" class="inline">
                    ${csrfField(ctx)}
                    <button type="submit" class="linklike">清空購物車</button>
                  </form>
                </div>
              </aside>
            </div>`}
      </article>`;
    return layout({ title: '購物車', body, ctx });
}

export function renderCheckout(ctx: ThemeContext, view: ThemeCheckoutView): string {
    const address = view.deliveryAddress;
    const money = (cents: number) => formatMoney(cents, view.currency, ctx.locale);
    const shippingOptions = view.shippingMethods.map((method) => {
      const freeAt = method.freeShippingThresholdCents === null
        ? ''
        : `，滿 ${money(method.freeShippingThresholdCents)} 免運`;
      const shippingCents = method.freeShippingThresholdCents !== null && view.subtotalCents >= method.freeShippingThresholdCents
        ? 0
        : method.feeCents;
      const shippingText = shippingCents === 0 && method.feeCents > 0 ? '免運' : `運費 ${money(shippingCents)}`;
      const label = method.destinationKind === 'pickup_store' ? `${method.name}（超商取貨，${shippingText}${freeAt}）` : `${method.name}（${shippingText}${freeAt}）`;
      return `<option value="${escapeHtml(method.id)}"${method.id === view.selectedShippingMethodId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    const paymentOptions = view.payment.methods.map((method) =>
      `<option value="${escapeHtml(method.code)}">${escapeHtml(method.label)}（${method.timing === 'deferred' ? '取得繳費資訊後付款' : '立即付款'}）</option>`,
    ).join('');
    const field = (label: string, name: string, value: string | null | undefined, extra = '') =>
      `<label>${label}<input name="${name}" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
    const canCheckout = view.shippingMethods.length > 0 && view.payment.methods.length > 0;
    const selectedMethod = view.shippingMethods.find((method) => method.id === view.selectedShippingMethodId);
    const needsPickupSelection = selectedMethod?.destinationKind === 'pickup_store' && !view.pickupSelection;
    const body = `
      <article class="checkout-page">
        ${pageHeading('建立訂單', '確認訂單', '請核對這次訂單的品項、金額與通知信箱。')}
        ${feedback(view.error, 'error')}
        ${removedNotice(view)}
        <div class="checkout-layout">
          <section class="checkout-content" aria-labelledby="checkout-items-title">
            <div class="checkout-email">
              <p class="checkout-email__label">訂單通知</p>
              <p>${escapeHtml(view.customerEmail)}</p>
            </div>
            <div class="section-heading">
              <h2 id="checkout-items-title">訂單品項</h2>
              <p>此頁不能修改數量；如需調整請回購物車。</p>
            </div>
            ${cartTable(ctx, view, false)}
          </section>
          <aside class="checkout-sidebar" aria-label="建立訂單">
            ${checkoutSummary(ctx, view)}
            <section class="checkout-submit">
              <p>先選配送方式並更新總額；建立訂單時仍會由伺服器再次確認費率與總額。</p>
              ${!view.shippingMethods.length ? feedback('目前沒有可用的配送方式，請聯絡商店。', 'error') : ''}
              ${!view.payment.methods.length ? feedback('目前沒有可用的付款方式，請聯絡商店。', 'error') : ''}
              <form method="get" action="/checkout" class="checkout-shipping-quote">
                <label>配送方式
                  <select name="shippingMethodId" required ${view.shippingMethods.length ? '' : 'disabled'}>
                    ${shippingOptions}
                  </select>
                </label>
                <button type="submit" ${view.shippingMethods.length ? '' : 'disabled'}>更新含運費總額</button>
              </form>
              <form method="post" action="/checkout">
                ${csrfField(ctx)}
                <input type="hidden" name="cartId" value="${escapeHtml(view.cartId)}">
                <input type="hidden" name="confirm" value="1">
                <input type="hidden" name="paymentProvider" value="${escapeHtml(view.payment.provider)}">
                <input type="hidden" name="shippingMethodId" value="${escapeHtml(view.selectedShippingMethodId)}">
                ${view.pickupSelection ? `<fieldset class="profile-form__section"><legend>已選門市</legend><p><strong>${escapeHtml(view.pickupSelection.storeName)}</strong><br>${escapeHtml(view.pickupSelection.storeAddress)}</p><input type="hidden" name="pickupSelectionToken" value="${escapeHtml(view.pickupSelection.token)}"><div class="form-grid">${field('取貨人', 'pickupRecipient', address?.recipient, 'required maxlength="120" autocomplete="shipping name"')}${field('取貨電話', 'pickupPhone', address?.phone, 'required type="tel" maxlength="40" autocomplete="shipping tel"')}</div></fieldset>` : needsPickupSelection ? '' : `<fieldset class="profile-form__section">
                  <legend>配送方式與收件地址</legend>
                  <div class="form-grid">
                    ${field('收件人', 'recipient', address?.recipient, 'required maxlength="120" autocomplete="shipping name"')}
                    ${field('收件電話', 'phone', address?.phone, 'required type="tel" maxlength="40" autocomplete="shipping tel"')}
                    ${field('郵遞區號', 'postcode', address?.postcode, 'required maxlength="20" autocomplete="shipping postal-code"')}
                    ${field('縣市', 'city', address?.city, 'required maxlength="80" autocomplete="shipping address-level1"')}
                    ${field('鄉鎮市區', 'district', address?.district, 'required maxlength="80" autocomplete="shipping address-level2"')}
                    ${field('地址', 'line1', address?.line1, 'required maxlength="200" autocomplete="shipping address-line1"')}
                    ${field('地址第二行', 'line2', address?.line2, 'maxlength="200" autocomplete="shipping address-line2"')}
                  </div>
                </fieldset>`}
                <fieldset class="profile-form__section">
                  <legend>付款方式</legend>
                  <label>付款方式
                    <select name="paymentMethod" required ${view.payment.methods.length ? '' : 'disabled'}>
                      ${paymentOptions}
                    </select>
                  </label>
                </fieldset>
                ${view.invoice?.enabled ? `<fieldset class="profile-form__section">
                  <legend>電子發票</legend>
                  <label>載具／捐贈選項
                    <select name="invoicePreference">
                      <option value="ecpay">綠界電子發票載具（以通知信箱歸戶）</option>
                      <option value="mobile">手機條碼載具</option>
                      <option value="natural_person">自然人憑證</option>
                      <option value="donation">捐贈發票</option>
                    </select>
                  </label>
                  <div class="form-grid">
                    ${field('手機條碼或自然人憑證號碼', 'invoiceCarrierNumber', null, 'maxlength="16"')}
                    ${field('愛心碼', 'invoiceLoveCode', null, 'inputmode="numeric" maxlength="7"')}
                  </div>
                  <p>選手機條碼或自然人憑證時填前一欄；選捐贈時填愛心碼。愛心碼會由綠界驗證。</p>
                </fieldset>` : ''}
                <button type="submit" ${canCheckout && !needsPickupSelection ? '' : 'disabled'}>建立訂單並前往付款</button>
              </form>
              ${needsPickupSelection ? `<form method="post" action="/checkout/pickup/start">${csrfField(ctx)}<input type="hidden" name="cartId" value="${escapeHtml(view.cartId)}"><input type="hidden" name="shippingMethodId" value="${escapeHtml(view.selectedShippingMethodId)}"><button type="submit">選擇超商門市</button></form>` : ''}
              <a class="secondary-action" href="/cart">回購物車修改</a>
            </section>
          </aside>
        </div>
      </article>`;
    return layout({ title: '確認訂單', body, ctx });
}

export function renderPickupStorePicker(ctx: ThemeContext, view: ThemePickupStorePickerView): string {
  const choices = view.stores.map((store) => `<label class="card"><input type="radio" name="providerStoreId" value="${escapeHtml(store.providerStoreId)}" required> <strong>${escapeHtml(store.storeName)}</strong><br><span class="muted">${escapeHtml(store.storeAddress)}</span></label>`).join('');
  const body = `<article><header class="page-heading"><p class="eyebrow">超商取貨</p><h1>選擇取貨門市</h1><p class="page-heading__copy">選定後會回到結帳頁；連結短暫有效。</p></header><form method="post" action="/checkout/pickup/callback"><input type="hidden" name="token" value="${escapeHtml(view.token)}">${choices || feedback('目前沒有可用門市。', 'error')}<button type="submit" ${view.stores.length ? '' : 'disabled'}>確認門市</button></form></article>`;
  return layout({ title: '選擇取貨門市', body, ctx });
}

export function renderAccountRewards(ctx: ThemeContext, { currency, balance, entries, tier }: ThemeAccountRewardsView): string {
    const money = (cents: number) => formatMoney(cents, currency, ctx.locale);
    const day = (at: Date) => escapeHtml(formatDate(at, { locale: ctx.locale, timeZone: ctx.timeZone }));

    const rows = entries.map((entry) => `
      <tr class="data-table__row">
        <td data-label="金額" class="${entry.amountCents < 0 ? '' : 'price'}">${entry.amountCents < 0 ? '−' : '+'}${money(Math.abs(entry.amountCents))}</td>
        <td data-label="說明">${escapeHtml(entry.description)}</td>
        <td data-label="時間" class="muted">${day(entry.createdAt)}</td>
        <td data-label="到期" class="muted">${entry.expiresAt ? day(entry.expiresAt) : '—'}</td>
      </tr>`).join('');

    const body = `
      <article class="account-page">
        ${accountIntro('rewards', '購物金與會員等級', '查看可折抵的購物金、等級與每一筆異動。')}
        <div class="account-stat-grid">
          <article class="account-stat">
            <p class="account-stat__label">可用購物金</p>
            <p class="account-stat__value">${money(balance.availableCents)}</p>
            ${balance.pendingCents > 0
              ? `<p class="muted">另有 ${money(balance.pendingCents)} 尚未生效</p>`
              : ''}
            ${balance.nextExpiry
              ? `<p class="muted">${money(balance.nextExpiry.amountCents)} 將於 ${day(balance.nextExpiry.expiresAt)} 到期</p>`
              : ''}
            ${balance.expiredCents > 0
              ? `<p class="muted">累計已有 ${money(balance.expiredCents)} 到期失效</p>`
              : ''}
          </article>
          <article class="account-stat">
            <p class="account-stat__label">目前等級</p>
            <h2>${escapeHtml(tier.name)}</h2>
            <p class="muted">等級積分 ${tier.points}</p>
            ${tier.next
              ? `<p class="muted">再累積 ${tier.next.remainingPoints} 點升到「${escapeHtml(tier.next.name)}」</p>`
              : '<p class="muted">你已經是最高等級。</p>'}
          </article>
        </div>
        <div class="notice" role="status"><p>
          會員等級看的是最近 ${tier.windowMonths} 個月（${day(tier.windowStartsAt)} 起）累積的等級積分，
          每天重新計算一次，因此會升也會降。等級積分不能折抵金額。
        </p></div>
        <section class="account-panel" aria-labelledby="reward-history-title">
          <div class="section-heading">
            <h2 id="reward-history-title">購物金紀錄</h2>
            <p>共 ${entries.length} 筆</p>
          </div>
          ${entries.length === 0
            ? '<div class="empty-state"><p>還沒有任何購物金紀錄。</p></div>'
            : `<table class="data-table">
                 <thead><tr><th scope="col">金額</th><th scope="col">說明</th><th scope="col">時間</th><th scope="col">到期</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>`}
        </section>
      </article>`;
    return layout({ title: '購物金與會員等級', body, ctx });
}

export function renderAccountCoupons(ctx: ThemeContext, { coupons }: ThemeAccountCouponsView): string {
    const rows = coupons.map((coupon) => `
      <tr class="data-table__row ${coupon.expiringSoon ? 'expiring' : ''}">
        <td data-label="折扣碼"><code>${escapeHtml(coupon.code)}</code></td>
        <td data-label="優惠">${escapeHtml(coupon.promotionName)}<br><span class="muted">${escapeHtml(coupon.description)}</span></td>
        <td data-label="使用期限">${coupon.endsAt ? escapeHtml(formatDate(coupon.endsAt, { locale: ctx.locale, timeZone: ctx.timeZone })) : '無期限'}</td>
        <td data-label="狀態">${couponStateText(coupon)}</td>
      </tr>`).join('');

    const body = `
      <article class="account-page">
        ${accountIntro('coupons', '我的券', '可使用的券會在購物車輸入折扣碼後套用。')}
        <section class="account-panel" aria-labelledby="coupon-list-title">
          <div class="section-heading">
            <h2 id="coupon-list-title">已持有的券</h2>
            <p>${coupons.length} 張</p>
          </div>
          ${coupons.length === 0
            ? '<div class="empty-state"><p>你目前沒有任何券。<a href="/">去逛逛</a></p></div>'
            : `<table class="data-table">
                 <thead><tr><th scope="col">折扣碼</th><th scope="col">優惠</th><th scope="col">使用期限</th><th scope="col">狀態</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>`}
        </section>
      </article>`;
    return layout({ title: '我的券', body, ctx });
}

export function renderOrder(ctx: ThemeContext, { order }: { order: ThemeOrderView }): string {
    const rows = order.lines.map((l) => `
      <tr class="data-table__row">
        <td data-label="商品">${escapeHtml(l.name)}</td>
        <td data-label="SKU">${escapeHtml(l.sku)}</td>
        <td data-label="數量">${l.quantity}</td>
        <td data-label="小計">${formatMoney(l.lineTotalCents, order.currency, ctx.locale)}</td>
      </tr>`).join('');
    const paymentNotice = order.status === 'payment_processing'
      ? feedback('付款處理中；此頁會在重新整理後顯示最新結果。')
      : order.status === 'awaiting_payment' ? feedback('請依下方繳費資訊完成付款。')
      : order.status === 'expired' ? feedback('付款逾時，已釋放保留庫存。') : '';
    const payment = order.payment
      ? `<section class="account-panel" aria-labelledby="payment-title">
          <div class="section-heading"><h2 id="payment-title">付款資訊</h2><p>${escapeHtml(order.payment.method)}</p></div>
          <p>付款狀態：${escapeHtml(order.payment.status)}</p>
          ${order.payment.status === 'awaiting_payment' && order.payment.expiresAt ? `<p class="muted">請於 ${escapeHtml(formatDateTime(order.payment.expiresAt, { locale: ctx.locale, timeZone: ctx.timeZone }))} 前完成付款。</p>` : ''}
          ${order.payment.status === 'failed' ? feedback('付款未完成，請重新選擇付款方式後再試。', 'error') : ''}
          ${order.payment.status === 'awaiting_payment' && order.payment.instructions
            ? `<dl>${order.payment.instructions.map((instruction) => `<div class="order-summary__row"><dt>${escapeHtml(instruction.label)}</dt><dd>${escapeHtml(instruction.value)}</dd></div>`).join('')}</dl>`
            : ''}
          ${paymentContinuation(order.payment)}
        </section>`
      : '';
    const paymentRetry = order.paymentRetry
      ? `<section class="account-panel" aria-labelledby="payment-retry-title">
          <div class="section-heading"><h2 id="payment-retry-title">重新付款</h2><p>建立新的付款嘗試</p></div>
          <p>先前付款未完成時，可以選擇方式後重新付款；舊的付款資訊不會重複使用。</p>
          <form method="post" action="/orders/${escapeHtml(order.number)}/pay">
            ${csrfField(ctx)}
            <input type="hidden" name="paymentProvider" value="${escapeHtml(order.paymentRetry.provider)}">
            <label>付款方式
              <select name="paymentMethod" required>
                ${order.paymentRetry.methods.map((method) => `<option value="${escapeHtml(method.code)}">${escapeHtml(method.label)}（${method.timing === 'deferred' ? '取得繳費資訊後付款' : '立即付款'}）</option>`).join('')}
              </select>
            </label>
            <button type="submit">重新付款</button>
          </form>
        </section>`
      : '';
    const invoice = order.invoice
      ? `<section class="account-panel" aria-labelledby="invoice-title">
          <div class="section-heading"><h2 id="invoice-title">電子發票</h2><p>${escapeHtml(order.invoice.status)}</p></div>
          <p>${order.invoice.invoiceNumber ? `發票號碼：${escapeHtml(order.invoice.invoiceNumber)}` : '發票正在處理，請稍後重新整理。'}</p>
        </section>`
      : '';
    const cancellation = order.canCancel
      ? `<section class="account-panel" aria-labelledby="cancel-order-title">
          <div class="section-heading"><h2 id="cancel-order-title">取消訂單</h2><p>尚未付款且未進入出貨流程</p></div>
          <p>取消後會釋放這張訂單保留的商品與折抵。</p>
          <form method="post" action="/orders/${escapeHtml(order.number)}/cancel">
            ${csrfField(ctx)}
            <button type="submit" class="linklike">取消此訂單</button>
          </form>
        </section>`
      : '';
    const delivery = order.delivery
      ? `<section class="account-panel" aria-labelledby="delivery-title">
          <div class="section-heading"><h2 id="delivery-title">配送資訊</h2><p>${escapeHtml(order.delivery.shippingMethodName)}</p></div>
          ${order.delivery.destination.kind === 'taiwan_home'
            ? `<p>${escapeHtml(order.delivery.destination.recipient)}（${escapeHtml(order.delivery.destination.phone)}）</p>
               <p>${escapeHtml(`${order.delivery.destination.postcode} ${order.delivery.destination.city}${order.delivery.destination.district}${order.delivery.destination.line1}${order.delivery.destination.line2 ?? ''}`)}</p>`
            : `<p>${escapeHtml(order.delivery.destination.recipient)}（${escapeHtml(order.delivery.destination.phone)}）</p>
               <p>${escapeHtml(order.delivery.destination.storeName)}：${escapeHtml(order.delivery.destination.storeAddress)}</p>`}
        </section>`
      : '';
    const shipment = order.shipment
      ? `<section class="account-panel" aria-labelledby="tracking-title">
          <div class="section-heading"><h2 id="tracking-title">配送進度</h2><p>${shipmentStatus(order.shipment.status)}</p></div>
          ${order.shipment.trackingNumber ? `<p>追蹤號碼：${escapeHtml(order.shipment.trackingNumber)}</p>` : '<p>物流單已建立，等待配送進度更新。</p>'}
          ${order.shipment.trackingUrl ? `<p><a href="${safeUrlAttribute(order.shipment.trackingUrl)}" rel="noopener noreferrer" target="_blank">查看物流追蹤</a></p>` : ''}
        </section>`
      : '';
    const refunds = order.refunds.length > 0
      ? `<section class="account-panel" aria-labelledby="refund-title">
          <div class="section-heading"><h2 id="refund-title">退款進度</h2><p>退款會依金流作業時間完成</p></div>
          <table class="data-table"><thead><tr><th scope="col">狀態</th><th scope="col">金額</th></tr></thead><tbody>
          ${order.refunds.map((refund) => `<tr><td data-label="狀態">${escapeHtml(refund.status)}</td><td data-label="金額">${formatMoney(refund.amountCents, order.currency, ctx.locale)}</td></tr>`).join('')}
          </tbody></table>
        </section>`
      : '';
    const rmaProgress = order.rmas.length > 0
      ? `<section class="account-panel" aria-labelledby="rma-progress-title">
          <div class="section-heading"><h2 id="rma-progress-title">退貨／換貨案件進度</h2><p>換貨採退款後重新下單處理</p></div>
          <ul>${order.rmas.map((rma) => `<li><strong>${rmaStatus(rma.status)}</strong>：${escapeHtml(rma.reason)}（${rma.lines.map((line) => `${escapeHtml(line.name)} × ${line.quantity}`).join('、')}）${rma.staffNote ? `<p>${escapeHtml(rma.staffNote)}</p>` : ''}</li>`).join('')}</ul>
        </section>`
      : '';
    const rmaRequest = order.canRequestRma
      ? `<section class="account-panel" aria-labelledby="rma-request-title">
          <div class="section-heading"><h2 id="rma-request-title">申請退貨／換貨</h2><p>選擇欲退回的品項與數量；是否符合資格仍由系統與客服確認。</p></div>
          <form method="post" action="/orders/${escapeHtml(order.number)}/rmas">
            ${csrfField(ctx)}
            <table class="data-table"><thead><tr><th scope="col">申請</th><th scope="col">商品</th><th scope="col">數量</th></tr></thead><tbody>
              ${order.lines.map((line) => `<tr><td><input type="checkbox" name="orderLineId" value="${escapeHtml(line.id)}" aria-label="申請退回 ${escapeHtml(line.name)}"></td><td>${escapeHtml(line.name)}</td><td><input type="number" name="quantity_${escapeHtml(line.id)}" min="1" max="${line.quantity}" value="${line.quantity}" aria-label="${escapeHtml(line.name)} 退貨數量"></td></tr>`).join('')}
            </tbody></table>
            <label>申請原因<textarea name="reason" required maxlength="1000"></textarea></label>
            <button type="submit">提出退貨／換貨申請</button>
          </form>
        </section>`
      : '';
    const body = `
      <article class="order-page">
        ${pageHeading('訂單紀錄', `訂單 ${order.number}`, '訂單建立後的狀態以此頁資訊為準。')}
        <div class="order-meta">
          <div><p class="order-meta__label">訂單狀態</p>${orderStatus(order.status)}</div>
          <div><p class="order-meta__label">通知信箱</p><p>${escapeHtml(order.customerEmail)}</p></div>
        </div>
        ${paymentNotice}
        ${payment}
        ${paymentRetry}
        ${invoice}
        ${cancellation}
        <div class="order-layout">
          <section class="account-panel" aria-labelledby="order-lines-title">
            <div class="section-heading"><h2 id="order-lines-title">訂單品項</h2><p>${order.lines.length} 項商品</p></div>
            <table class="data-table">
              <thead><tr><th scope="col">商品</th><th scope="col">SKU</th><th scope="col">數量</th><th scope="col">小計</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </section>
          <aside class="order-total-card" aria-label="訂單總計">
            <p>訂單總計</p>
            <strong>${formatMoney(order.totalCents, order.currency, ctx.locale)}</strong>
          </aside>
        </div>
        ${delivery}
        ${shipment}
        ${refunds}
        ${rmaProgress}
        ${rmaRequest}
        <p class="page-return"><a href="/">繼續購物</a></p>
      </article>`;
    return layout({ title: `訂單 ${order.number}`, body, ctx });
}

export function renderAccountOrders(ctx: ThemeContext, { orders, limit, offset, total }: ThemeAccountOrdersView): string {
    const rows = orders.map((o) => `
      <tr class="data-table__row">
        <td data-label="訂單編號"><a href="/orders/${escapeHtml(o.number)}">${escapeHtml(o.number)}</a></td>
        <td data-label="狀態">${orderStatus(o.status)}</td>
        <td data-label="件數">${o.lineCount}</td>
        <td data-label="總計">${formatMoney(o.totalCents, o.currency, ctx.locale)}</td>
        <td data-label="下單時間" class="muted">${escapeHtml(formatDate(o.placedAt, { locale: ctx.locale, timeZone: ctx.timeZone }))}</td>
      </tr>`).join('');

    const previous = offset > 0
      ? `<a href="/account/orders?limit=${limit}&offset=${Math.max(0, offset - limit)}">← 上一頁</a>`
      : '';
    const next = offset + limit < total
      ? `<a href="/account/orders?limit=${limit}&offset=${offset + limit}">下一頁 →</a>`
      : '';

    const body = `
      <article class="account-page">
        ${accountIntro('orders', '我的訂單', '查看已建立訂單與目前狀態。')}
        <section class="account-panel" aria-labelledby="order-list-title">
          <div class="section-heading">
            <h2 id="order-list-title">訂單紀錄</h2>
            <p>共 ${total} 張</p>
          </div>
          ${orders.length === 0
            ? '<div class="empty-state"><p>你還沒有任何訂單。<a href="/">去逛逛</a></p></div>'
            : `<table class="data-table">
                 <thead><tr><th scope="col">訂單編號</th><th scope="col">狀態</th><th scope="col">件數</th><th scope="col">總計</th><th scope="col">下單時間</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>
               <nav class="pagination" aria-label="訂單分頁">${previous || '<span></span>'}${next || '<span></span>'}</nav>`}
        </section>
      </article>`;
    return layout({ title: '我的訂單', body, ctx });
}

export function renderAccountProfile(ctx: ThemeContext, { displayName, phone, birthday, address, saved, error }: ThemeAccountProfileView): string {
    const field = (label: string, name: string, value: string | null, extra = '') =>
      `<label>${label}<input name="${name}" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
    const body = `
      <article class="account-page">
        ${accountIntro('profile', '個人資料', '管理聯絡方式與可供未來訂單使用的收件地址。')}
        ${saved ? feedback('已儲存。') : ''}
        ${feedback(error, 'error')}
        <form class="profile-form" method="post" action="/account/profile">
          ${csrfField(ctx)}
          <section class="profile-form__section" aria-labelledby="profile-contact-title">
            <h2 id="profile-contact-title">聯絡資料</h2>
            <div class="form-grid">
              ${field('顯示名稱', 'displayName', displayName, 'required maxlength="120" autocomplete="name"')}
              ${field('聯絡電話', 'phone', phone, 'type="tel" maxlength="40" autocomplete="tel"')}
              ${birthday
                ? `<div class="profile-birthday"><label>生日<input value="${escapeHtml(birthday)}" disabled></label>
                   <p class="muted">生日設定後不能自行修改，需要更正請聯絡客服。</p></div>`
                : `<div class="profile-birthday"><label>生日<input type="date" name="birthday" autocomplete="bday"></label>
                   <p class="muted">生日只能設定一次，之後要更正需要聯絡客服。</p></div>`}
            </div>
          </section>
          <fieldset class="profile-form__section">
            <legend>收件地址</legend>
            <p class="muted">目前儲存的地址供未來支援配送的訂單使用。</p>
            <div class="form-grid">
              ${field('收件人', 'recipient', address?.recipient ?? null, 'maxlength="120" autocomplete="shipping name"')}
              ${field('收件電話', 'addressPhone', address?.phone ?? null, 'type="tel" maxlength="40" autocomplete="shipping tel"')}
              ${field('郵遞區號', 'postcode', address?.postcode ?? null, 'maxlength="20" autocomplete="shipping postal-code"')}
              ${field('縣市', 'city', address?.city ?? null, 'maxlength="80" autocomplete="shipping address-level1"')}
              ${field('鄉鎮市區', 'district', address?.district ?? null, 'maxlength="80" autocomplete="shipping address-level2"')}
              ${field('地址', 'line1', address?.line1 ?? null, 'maxlength="200" autocomplete="shipping address-line1"')}
              ${field('地址第二行', 'line2', address?.line2 ?? null, 'maxlength="200" autocomplete="shipping address-line2"')}
            </div>
          </fieldset>
          <button type="submit">儲存個人資料</button>
        </form>
      </article>`;
    return layout({ title: '個人資料', body, ctx });
}

export function renderAuth(ctx: ThemeContext, view: ThemeAuthView): string {
  if (view.mode === 'forgot-password' || view.mode === 'reset-password') {
    return renderPasswordForm(ctx, view);
  }
  const { next, error } = view;
  const login = view.mode === 'login';
  const body = `
      <article class="auth-page">
        <section class="auth-card" aria-labelledby="auth-title">
          <div class="auth-card__header">
            <p class="eyebrow">帳戶存取</p>
            <h1 id="auth-title">${login ? '登入' : '註冊'}</h1>
            <p class="page-heading__copy">${login
              ? '登入後可以查看訂單、使用購物金並建立訂單。'
              : '建立帳戶後即可保存購物金、優惠券與訂單紀錄。'}</p>
          </div>
          ${feedback(error, 'error')}
          <form class="auth-form" method="post" action="${login ? '/login' : '/register'}">
            <input type="hidden" name="next" value="${escapeHtml(next)}">
            <label>電子郵件
              <input type="email" name="email" required placeholder="you@example.com" autocomplete="email">
            </label>
            ${login ? '' : `<label>顯示名稱
              <input type="text" name="displayName" maxlength="120" placeholder="怎麼稱呼你" autocomplete="name">
            </label>`}
            <label>密碼
              <input type="password" name="password" required minlength="${login ? 1 : 8}" autocomplete="${login ? 'current-password' : 'new-password'}">
            </label>
            <button type="submit">${login ? '登入' : '註冊'}</button>
          </form>
          <p class="auth-card__footer">${login
            ? `還沒有帳號？<a href="/register?next=${encodeURIComponent(next)}">註冊一個</a> · <a href="/forgot-password">忘記密碼</a>`
            : `已經有帳號了？<a href="/login?next=${encodeURIComponent(next)}">登入</a>`}</p>
        </section>
      </article>`;
  return layout({ title: login ? '登入' : '註冊', body, ctx });
}

export function renderError(ctx: ThemeContext, { status, message }: { status: number; message: string }): string {
  return layout({
    title: `錯誤 ${status}`,
    body: `<article class="error-page"><div class="error" role="alert"><p class="eyebrow">找不到頁面或無法完成操作</p><h1>${status}</h1><p>${escapeHtml(message)}</p><a class="secondary-action" href="/">回商品列表</a></div></article>`,
    ctx,
  });
}

/**
 * 預設 Storefront Theme：NestJS SSR，輸出純 HTML。
 * 沒有 JavaScript 也能完成瀏覽與下單——這個 Theme 根本不輸出任何 script。
 *
 * `renderers` 以 page id 為鍵——服務哪些頁面由這裡實作了哪些 id 決定，
 * 缺頁在啟動時比對出來並拒絕（ADR 0045）。`commerce.content.contact` 與
 * `commerce.content.submitContact` 共用同一個 renderer：兩者都渲染聯絡我們
 * 表單，差別只在有沒有送出結果，view 型別相同。`commerce.customer.profile`
 * 與 `commerce.customer.saveProfile` 同理。
 */
/**
 * 這個 Theme 服務的頁面集合。defineTheme 用它逐一比對每個 renderer 收到的 view，
 * 所以「訂單頁的資料少包一層」這種形狀錯誤是編譯期錯誤，不是上線後的 500。
 */
type ServedPages = typeof catalogPages & typeof cartPages & typeof orderPages
  & typeof contentPages & typeof customerPages & typeof couponPages
  & ReturnType<typeof createLoyaltyPages> & AuthPages;

export const defaultTheme = defineTheme<ServedPages>({
  id: 'default',
  name: 'Default Storefront',
  optionsSchema: defaultThemeOptions,
  editorialImageKeys: EDITORIAL_IMAGE_KEYS,

  renderers: {
    // 登入的顯示頁與送出頁共用同一個渲染函式，和聯絡我們同一個做法。
    // `platform.auth` 系統頁還在，因為註冊／忘記密碼／重設密碼尚未遷移（工單 95、96）。
    'platform.auth.login': renderAuth,
    'platform.auth.submitLogin': renderAuth,
    'commerce.catalog.home': renderHome,
    'commerce.catalog.view': renderCatalog,
    'commerce.catalog.product': renderProduct,
    'commerce.content.story': renderStory,
    'commerce.content.journalList': renderJournalList,
    'commerce.content.journalArticle': renderJournalArticle,
    'commerce.content.newsList': renderNewsList,
    'commerce.content.newsArticle': renderNewsArticle,
    'commerce.content.faq': renderFaq,
    'commerce.content.contact': renderContact,
    'commerce.content.submitContact': renderContact,
    'commerce.cart.view': renderCart,
    // 折扣碼失敗會帶著 couponError 重新渲染購物車頁，形狀與 cart.view 相同。
    'commerce.cart.coupon': renderCart,
    'commerce.checkout.view': renderCheckout,
    'commerce.checkout.pickupStorePicker': renderPickupStorePicker,
    'commerce.loyalty.rewards': renderAccountRewards,
    'commerce.coupon.accountList': renderAccountCoupons,
    'commerce.order.view': renderOrder,
    'commerce.order.accountList': renderAccountOrders,
    'commerce.customer.profile': renderAccountProfile,
    'commerce.customer.saveProfile': renderAccountProfile,
    'platform.auth': renderAuth,
    'platform.error': renderError,
  },
});

export * from './layout';
export default defaultTheme;
