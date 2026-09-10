import { describe, expect, it } from 'vitest';
import type { ThemeContext } from '@storeweave/kernel';
import type { ThemeCartView } from '@storeweave/cart';
import type { ThemeProductView } from '@storeweave/catalog';
import type { ThemeArticleView } from '@storeweave/content';
import type { ThemeOrderView } from '@storeweave/order';
import { defaultTheme } from '../src/index';

/**
 * 導覽是資料，不是 Theme 的一部分（ADR 0046）：這份是 storefront 組好之後交進來的樣子。
 * 「還沒發文就不出現品牌連結」的過濾發生在那之前，覆蓋在 `@storeweave/site` 的單元測試。
 */
const NAVIGATION = {
  primary: [
    { label: '首頁', href: '/' },
    { label: '商品型錄', href: '/catalog' },
    { label: '品牌故事', href: '/story' },
    { label: '生活誌', href: '/journal' },
    { label: '最新消息', href: '/news' },
    { label: '常見問題', href: '/faq' },
    { label: '聯絡我們', href: '/contact' },
    { label: '購物車', href: '/cart' },
  ],
  footer: [
    { label: '瀏覽商品', href: '/catalog', group: '商品' },
    { label: '訂單查詢', href: '/account/orders', group: '帳戶' },
  ],
} as const;

const context = (overrides: Partial<ThemeContext> = {}): ThemeContext => ({
  storeName: '織日選物',
  storeId: 'example-store',
  currency: 'TWD',
  locale: 'zh-TW',
  timeZone: 'Asia/Taipei',
  publicUrl: 'https://woven-day.example.test',
  supportEmail: 'hello@woven-day.example.test',
  options: { accentColor: '#8C3E28', showSku: true },
  tagline: '日常用品，認真挑選。',
  navigation: NAVIGATION,
  customerName: null,
  csrfToken: null,
  notice: null,
  ...overrides,
});

const product: ThemeProductView = {
  id: 'product-1',
  sku: 'WD-001',
  name: '日常托盤',
  description: '真實商品資料提供的描述。',
  priceCents: 128_000,
  currency: 'TWD',
  available: 3,
};

const story: ThemeArticleView = {
  kind: 'story',
  slug: 'woven-day',
  section: '織日選物 · Woven Day',
  title: '讓每天使用的物件，慢慢成為生活的一部分。',
  summary: '我們從每天會碰觸、會使用、也會被留下的事物開始。',
  body: [
    { heading: null, text: '不是為了把空間佈置得更滿，而是希望讓生活裡常見的一刻，多一點從容。' },
    { heading: '從手邊開始', text: '一只杯、一塊布、一張托盤，常常比想像中更接近生活的核心。' },
    { heading: '替留白保留位置', text: '好的物件不需要搶走空間的聲音。' },
  ],
  imageKey: 'story',
  publishedAt: new Date('2026-08-01T00:00:00Z'),
};

const journalArticle: ThemeArticleView = {
  kind: 'journal',
  slug: 'room-for-the-table',
  section: '日常提案',
  title: '為桌面留一塊空白',
  summary: '把最常使用的物件留在手邊，讓桌面成為可以慢下來的一小段地方。',
  body: [{ heading: null, text: '留下一小塊空白，是替下一個動作保留餘裕。' }],
  imageKey: 'story',
  publishedAt: new Date('2026-08-10T00:00:00Z'),
};

const newsArticle: ThemeArticleView = {
  kind: 'news',
  slug: 'holiday-shipping',
  section: '店務公告',
  title: '連假出貨安排',
  summary: '連假期間出貨會順延一個工作天。',
  body: [{ heading: null, text: '連假結束後會依下單順序依序出貨。' }],
  imageKey: null,
  publishedAt: new Date('2026-08-20T00:00:00Z'),
};

const faqEntry: ThemeArticleView = {
  kind: 'faq',
  slug: 'delivery-date',
  section: '出貨',
  title: '可以指定到貨日嗎？',
  summary: '',
  body: [{ heading: null, text: '目前無法指定，訂單成立後會依序安排出貨。' }],
  imageKey: null,
  publishedAt: new Date('2026-08-05T00:00:00Z'),
};

const cart: ThemeCartView = {
  cartId: 'cart-1',
  currency: 'TWD',
  lines: [{
    productId: 'product-1',
    sku: 'WD-001',
    name: '日常托盤',
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
  adjustments: [{ name: '夏日折扣', amountCents: -10_000 }],
  removedNames: ['停售商品'],
  nextThreshold: { name: '滿額折抵', remainingCents: 12_000 },
  coupon: { code: 'WOVEN10', discountCents: 10_000 },
  couponError: null,
  reward: { requestedCents: 3_000, appliedCents: 2_000, availableCents: 5_000, maxCents: 2_000 },
};

const order: ThemeOrderView = {
  number: 'ORD-1',
  status: 'paid',
  currency: 'TWD',
  totalCents: 118_000,
  customerEmail: 'buyer@example.test',
  lines: [{ id: 'line-1', sku: 'WD-001', name: '日常托盤', quantity: 1, lineTotalCents: 118_000 }],
  payment: null,
  paymentRetry: null,
  canCancel: false,
  delivery: null,
  shipment: null,
  refunds: [],
  canRequestRma: false,
  rmas: [],
};

describe('Default Theme 的商品瀏覽切片', () => {
  it('以 ThemeProductView 的資料建立可連到商品頁的型錄', () => {
    const html = defaultTheme.renderers['commerce.catalog.home'](context(), { products: [product], q: '', minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1, story: null, journal: [], news: [] });

    expect(html).toContain('class="catalog-page"');
    expect(html).toContain('class="product-card"');
    expect(html).toContain('href="/p/product-1"');
    expect(html).toContain('真實商品資料提供的描述。');
    expect(html).toContain('可售 3 件');
    // 字型走 Google Fonts 的 unicode-range 分片；Theme 不再自帶靜態資產。
    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400..700&amp;display=swap"');
    expect(html).toContain('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('/theme/default/');
    // 第三方 script 的立場沒有變：字型是樣式表，頁面仍然不載入任何外部 JavaScript。
    expect(html).not.toContain('<script');
  });

  it('只輸出 Theme 可證明的商品事實，導覽以外沒有寫死的品牌痕跡', () => {
    // 另一間商店的導覽裡沒有品牌內容——這是資料的結果，不是 Theme 的判斷（ADR 0046）。
    const ctx = context({
      storeName: '另一間商店', storeId: 'another-store',
      navigation: { primary: [{ label: '商品型錄', href: '/catalog' }], footer: [] },
    });
    const home = defaultTheme.renderers['commerce.catalog.home'](ctx, { products: [product], q: '', minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1, story: null, journal: [], news: [] });
    const catalog = defaultTheme.renderers['commerce.catalog.view'](ctx, { products: [product], q: '', minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1 });
    const detail = defaultTheme.renderers['commerce.catalog.product'](ctx, { product });

    for (const html of [home, catalog, detail]) {
      expect(html).not.toContain('images.unsplash.com');
      expect(html).not.toContain('織日選物');
      expect(html).not.toContain('href="/story"');
      expect(html).not.toContain('href="/journal"');
      expect(html).not.toContain('<span class="brand__mark"');
      expect(html).not.toContain('客服時間：');
      expect(html).not.toContain('/storefront-assets/');
    }
    expect(home).toContain('class="storefront-hero"');
    expect(home).toContain('正在販售的商品');
    expect(home).toContain('目前有 1 件商品可瀏覽。');
    expect(home).toContain('class="storefront-discovery"');
    expect(home).toContain('class="storefront-journey"');
    expect(home).toContain('依商品可售狀態選擇數量。');
    expect(catalog).not.toContain('<nav class="catalog-category-tabs"');
    expect(catalog).toContain('依商品名稱、SKU 或價格範圍找到正在販售的商品。');
    expect(detail).toContain('class="product-artwork"');
    expect(detail).toContain('aria-hidden="true" focusable="false"');
    expect(detail).not.toContain('工藝與使用指南');
    expect(detail).not.toContain('配送方式');

    const soldOutHome = defaultTheme.renderers['commerce.catalog.home'](ctx, {
      products: [{ ...product, available: 0 }], q: '', minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1, story: null, journal: [], news: [],
    });
    expect(soldOutHome).toContain('目前有 1 件商品可瀏覽。');
    expect(soldOutHome).not.toContain('目前有 1 件商品正在販售。');
  });

  it('把 Core 的品牌內容排進首頁、品牌故事、生活誌與最新消息', () => {
    const ctx = context();
    const home = defaultTheme.renderers['commerce.catalog.home'](ctx, {
      products: [product], q: '', minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1,
      story, journal: [journalArticle], news: [newsArticle],
    });
    const storyPage = defaultTheme.renderers['commerce.content.story'](ctx, { article: story });
    const journalPage = defaultTheme.renderers['commerce.content.journalList'](ctx, { kind: 'journal', articles: [journalArticle] });
    const articlePage = defaultTheme.renderers['commerce.content.journalArticle'](ctx, { article: journalArticle });
    const newsPage = defaultTheme.renderers['commerce.content.newsList'](ctx, { kind: 'news', articles: [newsArticle] });

    expect(home).toContain('織日選物 · Woven Day');
    expect(home).toContain('讓每天使用的物件，慢慢成為生活的一部分。');
    // hero 與品牌區塊讀同一篇故事，標題不可以印兩次。
    expect(home.match(/讓每天使用的物件，慢慢成為生活的一部分。/g)).toHaveLength(1);
    expect(home).toContain('href="/story"');
    expect(home).toContain('href="/journal"');
    expect(home).toContain('href="/news"');
    expect(home).toContain('href="/faq"');
    expect(home).toContain('href="/contact"');
    expect(home).toContain('為生活留下的筆記');
    expect(home).toContain('連假出貨安排');
    // Chapters are numbered by position, not by a number stored with the text.
    expect(home).toContain('<span>01</span><h3>從手邊開始</h3>');

    expect(storyPage).toContain('class="brand-story-page"');
    expect(storyPage).toContain('src="/storefront-assets/woven-day-story.png"');
    expect(storyPage).toContain('從手邊開始');
    expect(journalPage).toContain('class="journal-grid journal-grid--three"');
    expect(journalPage).toContain('src="/storefront-assets/woven-day-story.png"');
    expect(articlePage).toContain('為桌面留一塊空白');
    expect(articlePage).toContain('href="/journal"');
    expect(newsPage).toContain('連假出貨安排');
    expect(newsPage).toContain('<time datetime="2026-08-20">');
    expect(articlePage).not.toContain('images.unsplash.com');
  });

  it('導覽列印出資料給的項目，自己不決定有哪些', () => {
    const html = defaultTheme.renderers['commerce.catalog.home'](
      context({ navigation: { primary: [{ label: '關於', href: '/about' }], footer: [] } }), {
        products: [product], q: '', minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1,
        story: null, journal: [], news: [],
      });
    expect(html).toContain('<nav class="site-nav" aria-label="主要導覽"><a href="/about">關於</a></nav>');
    // 資料裡沒有的連結不會因為 Theme 覺得該有就冒出來（ADR 0046）。
    expect(html).not.toContain('href="/story"');
    expect(html).not.toContain('href="/cart"');
  });

  it('文章指向已經不存在的圖片 key 時，改用無圖版型而不是壞掉', () => {
    const html = defaultTheme.renderers['commerce.content.journalArticle'](context(), {
      article: { ...journalArticle, imageKey: 'removed-last-season' },
    });
    expect(html).toContain('為桌面留一塊空白');
    expect(html).not.toContain('storefront-assets/removed-last-season');
    expect(html).not.toContain('class="article-hero-art"');
  });

  it('常見問題依店家的分類分組，並導向聯絡我們', () => {
    const html = defaultTheme.renderers['commerce.content.faq'](context(), {
      kind: 'faq',
      articles: [
        { ...faqEntry, title: '可以指定到貨日嗎？', section: '出貨' },
        { ...faqEntry, slug: 'returns', title: '收到後可以退貨嗎？', section: '退換貨' },
      ],
    });
    expect(html).toContain('出貨');
    expect(html).toContain('退換貨');
    expect(html).toContain('可以指定到貨日嗎？');
    expect(html).toContain('href="/contact"');
  });

  it('聯絡我們是標準表單 POST，帶 honeypot 與 CSRF，送出後改顯示結果', () => {
    const form = defaultTheme.renderers['commerce.content.contact'](context({ csrfToken: 'token-1' }), {
      submitted: false, values: { name: '', email: '', subject: '', message: '' },
    });
    expect(form).toContain('method="post" action="/contact"');
    expect(form).toContain('name="_csrf" value="token-1"');
    expect(form).toContain('name="website"');
    expect(form).not.toContain('<script');

    const failed = defaultTheme.renderers['commerce.content.contact'](context(), {
      submitted: false, error: '請填寫訊息內容。',
      values: { name: '林小姐', email: 'a@example.test', subject: '出貨', message: '' },
    });
    expect(failed).toContain('請填寫訊息內容。');
    expect(failed).toContain('value="林小姐"');

    const done = defaultTheme.renderers['commerce.content.contact'](context(), {
      submitted: true, values: { name: '', email: '', subject: '', message: '' },
    });
    expect(done).toContain('訊息已送出');
    expect(done).not.toContain('name="website"');
  });

  it('為織日選物已知 SKU 輸出對應的商品攝影格位', () => {
    const productPhoto = { ...product, sku: 'WD-POT-01' };
    const home = defaultTheme.renderers['commerce.catalog.home'](context(), { products: [productPhoto], q: '', minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1, story: null, journal: [], news: [] });
    const detail = defaultTheme.renderers['commerce.catalog.product'](context(), { product: productPhoto });

    for (const html of [home, detail]) {
      expect(html).toContain('class="storefront-product-image');
      expect(html).toContain("background-image:url('/storefront-assets/woven-day-products-pottery.png')");
      expect(html).toContain('background-position:0% 0%');
    }
  });

  it('保留商品詳情的真實加車表單、session CSRF 與庫存上限', () => {
    const html = defaultTheme.renderers['commerce.catalog.product'](context({ csrfToken: 'csrf-token' }), { product });

    expect(html).toContain('class="product-page"');
    expect(html).toContain('action="/cart/items"');
    expect(html).toContain('name="productId" value="product-1"');
    expect(html).toContain('name="_csrf" value="csrf-token"');
    expect(html).toContain('name="quantity" value="1" min="1" max="3" required');
    expect(html).toContain('加入購物車');
  });

  it('售罄時不產生無效的加車表單，訪客也不被要求不存在的 CSRF token', () => {
    const soldOut = defaultTheme.renderers['commerce.catalog.product'](context(), {
      product: { ...product, available: 0 },
    });
    const untracked = defaultTheme.renderers['commerce.catalog.product'](context(), {
      product: { ...product, available: null },
    });

    expect(soldOut).toContain('已售完');
    expect(soldOut).not.toContain('class="product-form"');
    expect(soldOut).not.toContain('action="/cart/items"');
    expect(soldOut).not.toContain('name="quantity"');
    expect(soldOut).not.toContain('name="_csrf"');
    expect(untracked).not.toContain('已售完');
    expect(untracked).not.toContain('name="_csrf"');
    expect(untracked).toContain('action="/cart/items"');
    expect(untracked).toContain('name="quantity" value="1" min="1" required');
    expect(untracked).not.toContain('name="quantity" value="1" min="1" max=');
  });

  it('使用已知庫存作為精確數量上限，且不以購物車既有數量放寬上限', () => {
    const soldOut = defaultTheme.renderers['commerce.catalog.product'](context(), { product: { ...product, available: 0 } });
    const overAvailable = defaultTheme.renderers['commerce.cart.view'](context(), {
      ...cart,
      lines: [{ ...cart.lines[0], quantity: 5, available: 3 }],
    });
    const untracked = defaultTheme.renderers['commerce.cart.view'](context(), {
      ...cart,
      lines: [{ ...cart.lines[0], available: null }],
    });

    expect(soldOut).not.toContain('name="quantity" value="1" min="1" max="0" required');
    expect(soldOut).not.toContain('class="product-form"');
    expect(overAvailable).toContain('name="quantity" value="5" min="0" max="3" required');
    expect(untracked).toContain('name="quantity" value="1" min="0" required');
    expect(untracked).not.toContain('name="quantity" value="1" min="0" max=');
  });

  it('把購物車的真實品項、優惠與會員操作放進可近用的摘要版面，並保留所有寫入契約', () => {
    const html = defaultTheme.renderers['commerce.cart.view'](context({ customerName: '小美', csrfToken: 'csrf-token' }), cart);

    expect(html).toContain('class="cart-layout"');
    expect(html).toContain('class="cart-table"');
    expect(html).toContain('action="/cart/items/product-1"');
    expect(html).toContain('name="quantity" value="1" min="0"');
    expect(html).toContain('max="3" required');
    expect(html).toContain('name="_csrf" value="csrf-token"');
    expect(html).toContain('action="/cart/coupon"');
    expect(html).toContain('name="remove" value="1"');
    expect(html).toContain('action="/cart/rewards"');
    expect(html).toContain('action="/cart/clear"');
    expect(html).toContain('href="/checkout">前往結帳</a>');
    expect(html).toContain('夏日折扣');
    expect(html).toContain('再買');
    expect(html).toContain('這些商品已經買不到');
    expect(html).toContain('role="status"');
  });

  it('空車與確認訂單都有可理解的下一步，確認頁仍只送既有 cartId 與 confirm 欄位', () => {
    const empty = defaultTheme.renderers['commerce.cart.view'](context(), { ...cart, lines: [] });
    const checkout = defaultTheme.renderers['commerce.checkout.view'](context({ customerName: '小美', csrfToken: 'csrf-token' }), {
      ...cart,
      customerEmail: 'buyer@example.test',
      shippingMethods: [{ id: 'shipping-1', name: '宅配', feeCents: 6_000, freeShippingThresholdCents: 100_000 }],
      selectedShippingMethodId: 'shipping-1',
      shippingPreview: { shippingCents: 6_000, totalCents: 124_000 },
      deliveryAddress: { recipient: '小美', phone: '0911222333', postcode: '100', city: '台北市', district: '中正區', line1: '忠孝東路 1 號', line2: null },
      payment: { provider: 'mock', methods: [{ code: 'mock', label: '測試付款', timing: 'immediate' }] },
    });

    expect(empty).toContain('購物車是空的');
    expect(empty).toContain('href="/">返回商品列表</a>');
    expect(checkout).toContain('class="checkout-layout"');
    expect(checkout).toContain('buyer@example.test');
    expect(checkout).toContain('action="/checkout"');
    expect(checkout).toContain('name="cartId" value="cart-1"');
    expect(checkout).toContain('name="confirm" value="1"');
    expect(checkout).toContain('name="shippingMethodId"');
    expect(checkout).toContain('name="recipient" value="小美"');
    expect(checkout).toContain('name="paymentProvider" value="mock"');
    expect(checkout).toContain('name="paymentMethod"');
    expect(checkout).toContain('action="/checkout" class="checkout-shipping-quote"');
    expect(checkout).toContain('value="shipping-1" selected');
    expect(checkout).toContain('商品與折扣小計');
    expect(checkout).toContain('含運費總額');
    expect(checkout).toContain('更新含運費總額');
    expect(checkout).toContain('伺服器再次確認費率與總額');
    expect(checkout).toContain('name="_csrf" value="csrf-token"');
    expect(checkout).toContain('建立訂單');
    expect(checkout).not.toContain('action="/cart/items/product-1"');
  });

  it('讓帳戶存取與個人資料沿用同一套頁面結構，而不改變欄位名稱', () => {
    const login = defaultTheme.renderers['platform.auth'](context(), { mode: 'login', next: '/checkout', error: '登入失敗' });
    const profile = defaultTheme.renderers['commerce.customer.profile'](context({ customerName: '小美', csrfToken: 'csrf-token' }), {
      displayName: '小美',
      phone: '0911222333',
      birthday: null,
      address: null,
    });

    expect(login).toContain('class="auth-card"');
    expect(login).toContain('action="/login"');
    expect(login).toContain('name="next" value="/checkout"');
    expect(login).toContain('role="alert"');
    expect(profile).toContain('class="account-tabs"');
    expect(profile).toContain('action="/account/profile"');
    expect(profile).toContain('name="_csrf" value="csrf-token"');
    expect(profile).toContain('name="displayName"');
    expect(profile).toContain('name="recipient"');
    expect(profile).toContain('name="line2"');
  });

  it('保留既有訂單狀態標籤，未知狀態直接顯示 server 值', () => {
    const known = defaultTheme.renderers['commerce.order.view'](context(), { order });
    const unknown = defaultTheme.renderers['commerce.order.view'](context(), { order: { ...order, status: 'refunded' } });

    expect(known).toContain('付款完成');
    expect(unknown).toContain('>refunded</span>');
    expect(unknown).not.toContain('已退款');
  });

  it('訂單顯示配送快照、繳費資訊與須由顧客觸發的付款續行', () => {
    const html = defaultTheme.renderers['commerce.order.view'](context(), { order: {
      ...order,
      status: 'awaiting_payment',
      payment: {
        status: 'awaiting_payment', method: 'ATM', action: { type: 'redirect', url: 'https://payment.example.test/pay' },
        instructions: [{ label: '虛擬帳號', value: '12345678901234' }], expiresAt: new Date('2026-08-25T00:00:00.000Z'),
      },
      delivery: { shippingMethodName: '宅配', destination: { kind: 'taiwan_home', recipient: '小美', phone: '0911222333', postcode: '100', city: '台北市', district: '中正區', line1: '忠孝東路 1 號', line2: null } },
    } });

    expect(html).toContain('配送資訊');
    expect(html).toContain('宅配');
    expect(html).toContain('虛擬帳號');
    expect(html).toContain('12345678901234');
    expect(html).toContain('href="https://payment.example.test/pay"');
    expect(html).not.toContain('onload=');
  });

  it('只顯示顧客可理解的配送進度、追蹤號碼與安全的 provider 追蹤頁', () => {
    const html = defaultTheme.renderers['commerce.order.view'](context(), { order: {
      ...order,
      shipment: { status: 'arrived', trackingNumber: 'TW-TRACK-1', trackingUrl: 'https://carrier.example.test/track/TW-TRACK-1' },
    } });

    expect(html).toContain('配送進度');
    expect(html).toContain('已到店／送達');
    expect(html).not.toContain('<p>arrived</p>');
    expect(html).toContain('TW-TRACK-1');
    expect(html).toContain('href="https://carrier.example.test/track/TW-TRACK-1"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it.each([
    ['created', '物流單已建立'],
    ['shipped', '已出貨'],
    ['arrived', '已到店／送達'],
    ['completed', '配送完成'],
  ] as const)('maps shipment stage %s to customer copy', (status, label) => {
    const html = defaultTheme.renderers['commerce.order.view'](context(), { order: { ...order, shipment: { status, trackingNumber: null, trackingUrl: null } } });
    expect(html).toContain(label);
    expect(html).not.toContain(`<p>${status}</p>`);
  });

  it('renders a customer RMA request form and customer-safe progress', () => {
    const html = defaultTheme.renderers['commerce.order.view'](context({ csrfToken: 'csrf-token' }), { order: {
      ...order,
      canRequestRma: true,
      rmas: [{ status: 'needs_information', reason: '商品尺寸不合', staffNote: '請補充包裝照片', createdAt: new Date(), lines: [{ name: '日常托盤', quantity: 1 }] }],
    } });
    expect(html).toContain('action="/orders/ORD-1/rmas"');
    expect(html).toContain('name="orderLineId" value="line-1"');
    expect(html).toContain('name="quantity_line-1"');
    expect(html).toContain('name="reason"');
    expect(html).toContain('待補充資料');
    expect(html).toContain('請補充包裝照片');
  });

  it('失敗付款只顯示安全說明，並提供新的付款嘗試與未付款取消入口', () => {
    const html = defaultTheme.renderers['commerce.order.view'](context({ csrfToken: 'csrf-token' }), { order: {
      ...order,
      status: 'pending',
      payment: {
        status: 'failed', method: '信用卡',
        action: { type: 'redirect', url: 'https://provider.example.test/old-payment?CheckMacValue=secret' },
        instructions: [{ label: 'raw callback', value: 'HashKey=secret' }],
        expiresAt: new Date('2026-08-25T00:00:00.000Z'),
      },
      paymentRetry: { provider: 'mock-payment', methods: [{ code: 'mock', label: 'Mock payment', timing: 'immediate' }] },
      canCancel: true,
    } });

    expect(html).toContain('付款未完成，請重新選擇付款方式後再試。');
    expect(html).toContain('action="/orders/ORD-1/pay"');
    expect(html).toContain('action="/orders/ORD-1/cancel"');
    expect(html).toContain('name="_csrf" value="csrf-token"');
    expect(html).not.toContain('CheckMacValue=secret');
    expect(html).not.toContain('HashKey=secret');
  });

  it('使用指定的表面色與可預期的置頂頁首層級', () => {
    const html = defaultTheme.renderers['commerce.catalog.home'](context(), { products: [product], q: '', minPrice: null, maxPrice: null, page: 1, pageSize: 24, total: 1, story: null, journal: [], news: [] });

    expect(html).toContain('--surface-raised: #fffdfc;');
    expect(html).toContain('position: sticky;');
    expect(html).toContain('z-index: 5;');
    expect(html).toContain('top: 0;');
    expect(html).toContain('color: var(--state-danger-ink); background: var(--state-danger-surface);');
  });

  it('保留搜尋字串並以安全連結輸出分頁與空頁提示', () => {
    const html = defaultTheme.renderers['commerce.catalog.home'](context(), {
      products: [], q: '托盤 & <script>', minPrice: 300, maxPrice: 900, page: 4, pageSize: 12, total: 25, story: null, journal: [], news: [],
    });

    expect(html).toContain('role="search"');
    expect(html).toContain('name="q"');
    expect(html).toContain('name="minPrice" value="300"');
    expect(html).toContain('name="maxPrice" value="900"');
    expect(html).toContain('value="托盤 &amp; &lt;script&gt;"');
    expect(html).toContain('第 4 頁沒有商品');
    expect(html).toContain('href="/?q=%E6%89%98%E7%9B%A4+%26+%3Cscript%3E&amp;minPrice=300&amp;maxPrice=900"');
    expect(html).not.toContain('<script>');

    const priceOnlyEmpty = defaultTheme.renderers['commerce.catalog.home'](context(), {
      products: [], q: '', minPrice: 300, maxPrice: null, page: 1, pageSize: 24, total: 0, story: null, journal: [], news: [],
    });
    expect(priceOnlyEmpty).toContain('找不到符合目前篩選條件的商品。');
    expect(priceOnlyEmpty).not.toContain('目前沒有上架的商品。');
  });
});

describe('Default Theme 的退款狀態', () => {
  it('只呈現顧客安全的退款進度與金額', () => {
    const html = defaultTheme.renderers['commerce.order.view'](context(), { order: { ...order, refunds: [{ amountCents: 118_000, status: 'succeeded', requestedAt: new Date(), completedAt: new Date() }] } });
    expect(html).toContain('退款進度');
    expect(html).toContain('succeeded');
    expect(html).toContain('$1,180.00');
  });
});
