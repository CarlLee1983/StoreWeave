import { describe, expect, it } from 'vitest';
import type { ThemeAuthView, ThemeContext } from '@storeweave/kernel';
import type { ThemeCartView, ThemeCheckoutView } from '@storeweave/cart';
import type { ThemeProductView } from '@storeweave/catalog';
import type { ThemeArticleView } from '@storeweave/content';
import type { ThemeAccountCouponsView } from '@storeweave/coupon';
import type { ThemeAccountProfileView } from '@storeweave/customer';
import type { ThemeAccountRewardsView } from '@storeweave/loyalty';
import type { ThemeOrderView } from '@storeweave/order';
import { defaultTheme } from '../src/index';

/**
 * 這個 Theme 完全以字串拼接產生 HTML，而拼進去的是商品名稱、訂單編號、券碼、
 * 錯誤訊息這些顧客與後台都寫得到的資料。今天每個插值都包了 escapeHtml，但沒有
 * 任何測試守住這件事——下一個 `${}` 忘了包，失敗的形式是帶 session 頁面上的
 * stored XSS。因此每個 render 出口都在這裡餵一次攻擊字串。
 */
// 同時試兩種脫逃：開新標籤，以及從屬性值裡跳出去掛事件處理器。
const PROBE = '<img src=x onerror=alert(1)>" onfocus=alert(1) autofocus="';
const ESCAPED_PROBE = '&lt;img src=x onerror=alert(1)&gt;&quot; onfocus=alert(1) autofocus=&quot;';
const DATE = new Date('2026-08-24T00:00:00.000Z');

/**
 * 只比對「標記化之後才會出現」的位元組。`alert(1)` 這種字串在轉義後的文字裡本來就在，
 * 拿它當判準會讓測試永遠紅；判準是 `<` 有沒有活著、屬性的引號有沒有被關掉。
 */
const RAW_MARKUP = ['<img', '<script', '" onfocus=', "' onfocus="];

function expectNoMarkupInjection(html: string): void {
  for (const fragment of RAW_MARKUP) {
    expect(html).not.toContain(fragment);
  }
  expect(html).not.toContain(PROBE);
}

const context = (overrides: Partial<ThemeContext> = {}): ThemeContext => ({
  storeName: PROBE,
  storeId: 'woven-day',
  currency: 'TWD',
  locale: 'zh-TW',
  timeZone: 'Asia/Taipei',
  publicUrl: 'https://woven-day.example.test',
  supportEmail: PROBE,
  options: { accentColor: '#8C3E28', tagline: PROBE, showSku: true },
  customerName: PROBE,
  csrfToken: PROBE,
  notice: PROBE,
  ...overrides,
});

const product: ThemeProductView = {
  id: PROBE,
  sku: PROBE,
  name: PROBE,
  description: PROBE,
  priceCents: 128_000,
  currency: 'TWD',
  available: 3,
};

const cart: ThemeCartView = {
  cartId: PROBE,
  currency: 'TWD',
  lines: [{
    productId: PROBE,
    sku: PROBE,
    name: PROBE,
    unitPriceCents: 128_000,
    quantity: 1,
    lineTotalCents: 128_000,
    discountCents: 10_000,
    netCents: 118_000,
    available: 3,
  }],
  subtotalCents: 128_000,
  discountCents: 10_000,
  totalCents: 118_000,
  adjustments: [{ name: PROBE, amountCents: -10_000 }],
  removedNames: [PROBE],
  nextThreshold: { name: PROBE, remainingCents: 12_000 },
  coupon: { code: PROBE, discountCents: 10_000 },
  couponError: PROBE,
  reward: { requestedCents: 3_000, appliedCents: 2_000, availableCents: 5_000, maxCents: 2_000 },
  error: PROBE,
};

const checkout: ThemeCheckoutView = {
  ...cart,
  customerEmail: PROBE,
  shippingMethods: [{ id: PROBE, name: PROBE, feeCents: 100, freeShippingThresholdCents: 1_000 }],
  selectedShippingMethodId: PROBE,
  shippingPreview: { shippingCents: 100, totalCents: 118_100 },
  deliveryAddress: { recipient: PROBE, phone: PROBE, postcode: PROBE, city: PROBE, district: PROBE, line1: PROBE, line2: PROBE },
  payment: { provider: PROBE, methods: [{ code: PROBE, label: PROBE, timing: 'immediate' }] },
};

const order: ThemeOrderView = {
  number: PROBE,
  status: PROBE,
  currency: 'TWD',
  totalCents: 118_000,
  customerEmail: PROBE,
  lines: [{ id: 'line-1', sku: PROBE, name: PROBE, quantity: 1, lineTotalCents: 118_000 }],
  payment: {
    status: 'submitted', method: PROBE, action: { type: 'form_post', url: 'https://payment.example.test/pay', fields: { MerchantTradeNo: PROBE } },
    instructions: [{ label: PROBE, value: PROBE }], expiresAt: DATE,
  },
  paymentRetry: { provider: PROBE, methods: [{ code: PROBE, label: PROBE, timing: 'immediate' }] },
  canCancel: true,
  delivery: { shippingMethodName: PROBE, destination: { kind: 'taiwan_home', recipient: PROBE, phone: PROBE, postcode: PROBE, city: PROBE, district: PROBE, line1: PROBE, line2: PROBE } },
  shipment: { status: 'shipped', trackingNumber: PROBE, trackingUrl: 'https://carrier.example.test/track' },
  refunds: [],
  canRequestRma: false,
  rmas: [],
};

const rewards: ThemeAccountRewardsView = {
  currency: 'TWD',
  balance: {
    availableCents: 5_000,
    pendingCents: 1_000,
    expiredCents: 500,
    nextExpiry: { amountCents: 1_000, expiresAt: DATE },
  },
  entries: [{ amountCents: 1_000, description: PROBE, effectiveAt: DATE, expiresAt: DATE, createdAt: DATE }],
  tier: {
    name: PROBE,
    points: 120,
    next: { name: PROBE, remainingPoints: 80 },
    windowStartsAt: DATE,
    windowMonths: 12,
  },
};

const coupons: ThemeAccountCouponsView = {
  coupons: [{
    code: PROBE,
    promotionName: PROBE,
    description: PROBE,
    status: 'issued',
    endsAt: DATE,
    expiringSoon: true,
    usable: true,
    unusableReason: null,
  }],
};

const profile: ThemeAccountProfileView = {
  displayName: PROBE,
  phone: PROBE,
  birthday: PROBE,
  address: { countryCode: 'TW', recipient: PROBE, phone: PROBE, postcode: PROBE, city: PROBE, district: PROBE, line1: PROBE, line2: PROBE },
  saved: true,
  error: PROBE,
};

/** Every article field a merchant can type is a probe: the storefront renders them raw. */
const probeArticle = (kind: ThemeArticleView['kind']): ThemeArticleView => ({
  kind,
  slug: PROBE,
  section: PROBE,
  title: PROBE,
  summary: PROBE,
  body: [{ heading: PROBE, text: PROBE }, { heading: null, text: PROBE }],
  imageKey: PROBE,
  publishedAt: DATE,
});

const surfaces: [name: string, render: () => string][] = [
  ['renderHome', () => defaultTheme.renderers['commerce.catalog.home'](context(), {
    products: [product], q: PROBE, minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1,
    story: probeArticle('story'), journal: [probeArticle('journal')], news: [probeArticle('news')],
  })],
  ['renderStory', () => defaultTheme.renderers['commerce.content.story'](context(), { article: probeArticle('story') })],
  ['renderJournalList', () => defaultTheme.renderers['commerce.content.journalList'](context(), { kind: 'journal', articles: [probeArticle('journal')] })],
  ['renderJournalArticle', () => defaultTheme.renderers['commerce.content.journalArticle'](context(), { article: probeArticle('journal') })],
  ['renderNewsList', () => defaultTheme.renderers['commerce.content.newsList'](context(), { kind: 'news', articles: [probeArticle('news')] })],
  ['renderNewsArticle', () => defaultTheme.renderers['commerce.content.newsArticle'](context(), { article: probeArticle('news') })],
  ['renderFaq', () => defaultTheme.renderers['commerce.content.faq'](context(), { kind: 'faq', articles: [probeArticle('faq')] })],
  // The only surface that reflects an attacker's own submission straight back.
  ['renderContact', () => defaultTheme.renderers['commerce.content.contact'](context(), {
    submitted: false, error: PROBE, values: { name: PROBE, email: PROBE, subject: PROBE, message: PROBE },
  })],
  ['renderProduct', () => defaultTheme.renderers['commerce.catalog.product'](context(), { product })],
  ['renderCart', () => defaultTheme.renderers['commerce.cart.view'](context(), cart)],
  ['renderCheckout', () => defaultTheme.renderers['commerce.checkout.view'](context(), checkout)],
  ['renderOrder', () => defaultTheme.renderers['commerce.order.view'](context(), { order })],
  ['renderAccountRewards', () => defaultTheme.renderers['commerce.loyalty.rewards'](context(), rewards)],
  ['renderAccountCoupons', () => defaultTheme.renderers['commerce.coupon.accountList'](context(), coupons)],
  ['renderAccountProfile', () => defaultTheme.renderers['commerce.customer.profile'](context(), profile)],
  ['renderAccountOrders', () => defaultTheme.renderers['commerce.order.accountList'](context(), {
    orders: [{ number: PROBE, status: PROBE, currency: 'TWD', totalCents: 118_000, placedAt: DATE, lineCount: 1 }],
    limit: 20,
    offset: 0,
    total: 1,
  })],
  ['renderError', () => defaultTheme.renderers['platform.error'](context(), { status: 404, message: PROBE })],
];

const authModes: ThemeAuthView[] = [
  { mode: 'login', next: PROBE, error: PROBE },
  { mode: 'register', next: PROBE, error: PROBE },
  { mode: 'forgot-password', next: PROBE, error: PROBE, notice: PROBE },
  { mode: 'reset-password', next: PROBE, error: PROBE, token: PROBE },
];

describe('Default Theme 把資料當文字輸出', () => {
  it.each(surfaces)('%s 不讓資料變成標記', (_name, render) => {
    const html = render();

    expectNoMarkupInjection(html);
    expect(html).toContain(ESCAPED_PROBE);
  });

  it.each(authModes.map((view) => [view.mode, view] as const))('renderAuth（%s）不讓資料變成標記', (_mode, view) => {
    const html = defaultTheme.renderers['platform.auth'](context(), view);

    expectNoMarkupInjection(html);
  });

  it('未登入的訪客頁面同樣不被 notice 與店名注入', () => {
    const html = defaultTheme.renderers['commerce.catalog.home'](
      context({ customerName: null, csrfToken: null }),
      { products: [product], q: PROBE, minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1, story: null, journal: [], news: [] },
    );

    expectNoMarkupInjection(html);
  });

  it('CSRF token 進到表單隱藏欄位時是轉義過的值', () => {
    const html = defaultTheme.renderers['commerce.catalog.product'](context(), { product });

    expectNoMarkupInjection(html);
    expect(html).toContain(`name="_csrf" value="${ESCAPED_PROBE}"`);
  });
});
