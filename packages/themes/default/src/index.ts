import { z } from 'zod';
import type {
  StorefrontTheme, ThemeAccountCouponsView, ThemeAuthView, ThemeCartView, ThemeCatalogView, ThemeContext, ThemeOrderView,
} from '@storeweave/kernel';
import { escapeHtml, formatMoney, layout } from './layout';

type AccountSection = 'orders' | 'coupons' | 'rewards' | 'profile';

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
      <a class="cta" href="${escapeHtml(url)}" rel="noopener noreferrer">前往付款</a>
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
function checkoutSummary(ctx: ThemeContext, view: import('@storeweave/kernel').ThemeCheckoutView): string {
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

/** 伺服器渲染的表單以隱藏欄位做 CSRF 雙提交——瀏覽器的原生表單送不出自訂 header。 */
function csrfField(ctx: { csrfToken?: string | null }): string {
  return ctx.csrfToken ? `<input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrfToken)}">` : '';
}

export const defaultThemeOptions = z.object({
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8C3E28'),
  tagline: z.string().max(120).default(''),
  showSku: z.boolean().default(true),
});

/**
 * 預設 Storefront Theme：NestJS SSR，輸出純 HTML。
 * 沒有 JavaScript 也能完成瀏覽與下單——這個 Theme 根本不輸出任何 script。
 */
export const defaultTheme: StorefrontTheme = {
  id: 'default',
  name: 'Default Storefront',
  optionsSchema: defaultThemeOptions,

  renderHome(ctx, { products, q, minPrice, maxPrice, page, pageSize, total }: ThemeCatalogView) {
    const cards = products.map((product) => {
      const soldOut = product.available !== null && product.available <= 0;
      const availability = product.available === null
        ? ''
        : product.available > 0 ? `可售 ${product.available} 件` : '已售完';
      return `
        <article class="product-card">
          <a class="product-card__link" href="/p/${escapeHtml(product.id)}" aria-label="${escapeHtml(product.name)} 的商品詳情">
            <div>
              <span class="product-card__tag">選物精選</span>
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
    }).join('');
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const outOfRange = total > 0 && page > pageCount;
    const hasFilters = Boolean(q) || minPrice !== null || maxPrice !== null;
    const heading = q ? `搜尋「${escapeHtml(q)}」` : '目前商品';
    const empty = outOfRange
      ? `<p class="empty-state">第 ${page} 頁沒有商品。<a href="${escapeHtml(catalogUrl(q, minPrice, maxPrice, 1))}">回到第一頁</a></p>`
      : hasFilters ? '<p class="empty-state">找不到符合目前篩選條件的商品。</p>' : '<p class="empty-state">目前沒有上架的商品。</p>';
    const pagination = pageCount > 1 ? `<nav class="catalog-pagination" aria-label="商品分頁">
      ${page > 1 ? `<a href="${escapeHtml(catalogUrl(q, minPrice, maxPrice, page - 1))}" rel="prev">上一頁</a>` : '<span aria-hidden="true">上一頁</span>'}
      <span>第 ${page}／${pageCount} 頁</span>
      ${page < pageCount ? `<a href="${escapeHtml(catalogUrl(q, minPrice, maxPrice, page + 1))}" rel="next">下一頁</a>` : '<span aria-hidden="true">下一頁</span>'}
    </nav>` : '';

    const heroSection = `
      <section class="catalog-hero" aria-labelledby="catalog-title">
        <div>
          <p class="eyebrow">生活風格提案 · ${escapeHtml(ctx.storeName)}</p>
          <h1 id="catalog-title">日日相伴的器物與織物，<br>讓生活回歸本質。</h1>
          <p class="catalog-hero__copy">從手作陶皿到天然亞麻，我們用心採集每件溫潤質樸的日常器物。尊重材質本身的紋理，陪伴日常三餐與四季流轉。</p>
          <div class="catalog-hero__actions">
            <a class="cta" href="#products-title">探索本季選品</a>
            <a class="secondary-action" href="#philosophy">了解品牌工藝</a>
          </div>
        </div>
      </section>`;

    const brandPillars = `
      <section class="brand-pillars" id="pillars" aria-label="品牌承諾與服務">
        <article class="pillar-card">
          <span class="pillar-icon" aria-hidden="true">🌿</span>
          <h3>天然與手作質地</h3>
          <p>嚴選天然陶土、原木與天然亞麻，保留自然質樸紋理與手作溫度。</p>
        </article>
        <article class="pillar-card">
          <span class="pillar-icon" aria-hidden="true">📦</span>
          <h3>全站滿額免運</h3>
          <p>單筆消費滿額即享宅配或超商免費配送，安心包裝快速送達。</p>
        </article>
        <article class="pillar-card">
          <span class="pillar-icon" aria-hidden="true">🕊️</span>
          <h3>7 日安心鑑賞</h3>
          <p>提供完整售後服務與透明退換保障，讓每次選物都安心無憂。</p>
        </article>
        <article class="pillar-card">
          <span class="pillar-icon" aria-hidden="true">🏷️</span>
          <h3>會員購物金回饋</h3>
          <p>每筆消費均享點數累積與等級加成，生日再享專屬折扣禮遇。</p>
        </article>
      </section>`;

    const curatedBento = `
      <section class="curated-section" id="curated" aria-labelledby="curated-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">精選系列</p>
            <h2 id="curated-title">生活場景策展</h2>
          </div>
          <p>為不同時段與空間準備的選物提案</p>
        </div>
        <div class="curated-grid">
          <a class="curated-card" href="#products-title">
            <div>
              <p class="curated-card__tag">Dining & Kitchen</p>
              <h3>日常器皿</h3>
              <p>溫潤觸感的陶作器皿與碗盤，承載三餐日常的煙火氣息與料理溫度。</p>
            </div>
            <span class="curated-card__cta">探索器皿 →</span>
          </a>
          <a class="curated-card" href="#products-title">
            <div>
              <p class="curated-card__tag">Textile & Living</p>
              <h3>手織布品</h3>
              <p>具備呼吸感的純麻與棉織布品，越洗越柔軟的親膚觸感與自然垂墜。</p>
            </div>
            <span class="curated-card__cta">探索織品 →</span>
          </a>
          <a class="curated-card" href="#products-title">
            <div>
              <p class="curated-card__tag">Wooden Utensils</p>
              <h3>木作與生活道具</h3>
              <p>保留天然木紋的質樸托盤與收納道具，為桌面帶來沉靜秩序感。</p>
            </div>
            <span class="curated-card__cta">探索木作 →</span>
          </a>
        </div>
      </section>`;

    const philosophySection = `
      <section class="philosophy-section" id="philosophy" aria-labelledby="philosophy-title">
        <div class="philosophy-header">
          <p class="eyebrow">品牌工藝精神</p>
          <h2 id="philosophy-title">把時間花在<br>看不見的細節上</h2>
        </div>
        <div class="philosophy-content">
          <p>我們相信一件好的器物，不僅在於造型的美感，更在於被雙手捧起時的重量、盛裝熱湯時的溫潤，以及隨時光流逝所留下的使用痕跡。</p>
          <p>織日選物走訪各地的獨立工作坊與職人，堅持選用對環境友善的天然素材。每一件物品都經過真實生活場景的驗證，只為成為你日常中最長久、最安心的陪伴。</p>
        </div>
      </section>`;

    const journalSection = `
      <section class="journal-section" id="journal" aria-labelledby="journal-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Woven Journal</p>
            <h2 id="journal-title">品牌誌 · 日常選物筆記</h2>
          </div>
          <p>器物保養指南與空間搭配靈感</p>
        </div>
        <div class="journal-grid">
          <article class="journal-card">
            <div class="journal-card__meta">
              <span>器物保養</span> · <span>5 分鐘閱讀</span>
            </div>
            <h3>如何養出一只溫潤質樸的陶杯？</h3>
            <p>陶器是有毛細孔的器物。從初次使用前的「開陶」淘米水浸泡，到日常使用後的徹底風乾，了解善待陶皿的溫柔心法。</p>
            <span class="journal-card__read">閱讀專題 →</span>
          </article>
          <article class="journal-card">
            <div class="journal-card__meta">
              <span>居家風格</span> · <span>4 分鐘閱讀</span>
            </div>
            <h3>晨光與亞麻：讓空間自然呼吸的織物佈置學</h3>
            <p>亞麻不只適合盛夏。探索如何利用不同織度與垂墜感的亞麻餐墊、抱枕套與布巾，為室內光線注入柔和濾鏡。</p>
            <span class="journal-card__read">閱讀專題 →</span>
          </article>
        </div>
      </section>`;

    const memberBanner = `
      <section class="member-banner" aria-labelledby="member-banner-title">
        <div class="member-banner__content">
          <p class="eyebrow">會員專屬禮遇</p>
          <h2 id="member-banner-title">加入織日選物，開啟溫潤生活日常</h2>
          <p>新會員註冊即領 $100 專屬購物金。每次消費皆可累積等級積分與回饋購物金，享有會員日專屬折扣。</p>
        </div>
        <div class="member-banner__actions">
          ${ctx.customerName ? '<a class="cta" href="/account/orders">前往會員中心</a>' : `<a class="cta" href="/register">免費註冊領取</a><a class="secondary-action" href="/login">會員登入</a>`}
        </div>
      </section>`;

    const isFilteredOrPaged = hasFilters || page > 1;

    const body = `
      <div class="catalog-page">
        ${isFilteredOrPaged ? '' : heroSection}
        ${isFilteredOrPaged ? '' : brandPillars}
        ${isFilteredOrPaged ? '' : curatedBento}
        <section class="catalog-section" aria-labelledby="products-title">
          <div class="catalog-section__header">
            <h2 id="products-title">${heading}</h2>
            <p class="catalog-section__count">共 ${total} 件上架商品</p>
          </div>
          <form class="catalog-search" method="get" action="/" role="search">
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
        ${isFilteredOrPaged ? '' : philosophySection}
        ${isFilteredOrPaged ? '' : journalSection}
        ${isFilteredOrPaged ? '' : memberBanner}
      </div>`;
    return layout({ title: '商品', body, ctx });
  },

  renderProduct(ctx, { product }) {
    const soldOut = product.available !== null && product.available <= 0;
    const availability = product.available === null
      ? ''
      : product.available > 0 ? `可售 ${product.available} 件` : '已售完';
    const body = `
      <article class="product-page">
        <nav class="breadcrumb" aria-label="麵包屑">
          <a href="/">商品選購</a><span aria-hidden="true"> / </span><span>${escapeHtml(product.name)}</span>
        </nav>
        <div class="product-detail">
          <section class="product-detail__content">
            <div>
              <p class="eyebrow">商品詳情</p>
              <h1>${escapeHtml(product.name)}</h1>
              ${ctx.options.showSku !== false ? `<p class="product-detail__sku">${escapeHtml(product.sku)}</p>` : ''}
            </div>
            ${product.description ? `<p class="product-detail__description">${escapeHtml(product.description)}</p>` : ''}
            <section class="product-specs" aria-label="規格與工藝說明">
              <h3>工藝與使用指南</h3>
              <dl class="product-specs-list">
                <div class="spec-item">
                  <dt>材質與工藝</dt>
                  <dd>天然原料製作 / 質樸手作質地</dd>
                </div>
                <div class="spec-item">
                  <dt>日常清潔</dt>
                  <dd>以溫水與中性洗劑沖洗，置於通風處陰乾</dd>
                </div>
                <div class="spec-item">
                  <dt>配送方式</dt>
                  <dd>支援黑貓宅配到府 / 超商取貨</dd>
                </div>
                <div class="spec-item">
                  <dt>售後保障</dt>
                  <dd>全站享 7 日安心鑑賞期與品質承諾</dd>
                </div>
              </dl>
            </section>
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
            <div class="product-guarantees">
              <div><span>✓</span> 全站消費滿額享免運服務</div>
              <div><span>✓</span> 登入會員本單享購物金回饋</div>
              <div><span>✓</span> 嚴選天然材質與安心包裝</div>
            </div>
          </aside>
        </div>
      </article>`;
    return layout({ title: product.name, body, ctx });
  },

  renderCart(ctx, view) {
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
  },

  renderCheckout(ctx, view) {
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
  },

  renderPickupStorePicker(ctx, view) {
    const choices = view.stores.map((store) => `<label class="card"><input type="radio" name="providerStoreId" value="${escapeHtml(store.providerStoreId)}" required> <strong>${escapeHtml(store.storeName)}</strong><br><span class="muted">${escapeHtml(store.storeAddress)}</span></label>`).join('');
    const body = `<article><header class="page-heading"><p class="eyebrow">超商取貨</p><h1>選擇取貨門市</h1><p class="page-heading__copy">選定後會回到結帳頁；連結短暫有效。</p></header><form method="post" action="/checkout/pickup/callback"><input type="hidden" name="token" value="${escapeHtml(view.token)}">${choices || feedback('目前沒有可用門市。', 'error')}<button type="submit" ${view.stores.length ? '' : 'disabled'}>確認門市</button></form></article>`;
    return layout({ title: '選擇取貨門市', body, ctx });
  },

  renderAccountRewards(ctx, { currency, balance, entries, tier }) {
    const money = (cents: number) => formatMoney(cents, currency, ctx.locale);
    const day = (at: Date) => escapeHtml(at.toLocaleDateString(ctx.locale));

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
  },

  renderAccountCoupons(ctx, { coupons }) {
    const rows = coupons.map((coupon) => `
      <tr class="data-table__row ${coupon.expiringSoon ? 'expiring' : ''}">
        <td data-label="折扣碼"><code>${escapeHtml(coupon.code)}</code></td>
        <td data-label="優惠">${escapeHtml(coupon.promotionName)}<br><span class="muted">${escapeHtml(coupon.description)}</span></td>
        <td data-label="使用期限">${coupon.endsAt ? escapeHtml(coupon.endsAt.toLocaleDateString(ctx.locale)) : '無期限'}</td>
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
  },

  renderOrder(ctx, { order }) {
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
          ${order.payment.status === 'awaiting_payment' && order.payment.expiresAt ? `<p class="muted">請於 ${escapeHtml(order.payment.expiresAt.toLocaleString(ctx.locale))} 前完成付款。</p>` : ''}
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
          ${order.shipment.trackingUrl ? `<p><a href="${escapeHtml(order.shipment.trackingUrl)}" rel="noopener noreferrer" target="_blank">查看物流追蹤</a></p>` : ''}
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
  },

  renderAccountOrders(ctx, { orders, limit, offset, total }) {
    const rows = orders.map((o) => `
      <tr class="data-table__row">
        <td data-label="訂單編號"><a href="/orders/${escapeHtml(o.number)}">${escapeHtml(o.number)}</a></td>
        <td data-label="狀態">${orderStatus(o.status)}</td>
        <td data-label="件數">${o.lineCount}</td>
        <td data-label="總計">${formatMoney(o.totalCents, o.currency, ctx.locale)}</td>
        <td data-label="下單時間" class="muted">${escapeHtml(o.placedAt.toLocaleDateString(ctx.locale))}</td>
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
  },

  renderAccountProfile(ctx, { displayName, phone, birthday, address, saved, error }) {
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
  },

  renderAuth(ctx, view) {
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
  },

  renderError(ctx, { status, message }) {
    return layout({
      title: `錯誤 ${status}`,
      body: `<article class="error-page"><div class="error" role="alert"><p class="eyebrow">找不到頁面或無法完成操作</p><h1>${status}</h1><p>${escapeHtml(message)}</p><a class="secondary-action" href="/">回商品列表</a></div></article>`,
      ctx,
    });
  },
};

export * from './layout';
export default defaultTheme;
