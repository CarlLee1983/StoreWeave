import { describe, expect, it } from 'vitest';
import type { ThemeCartView, ThemeContext, ThemeOrderView, ThemeProductView } from '@storeweave/kernel';
import { defaultTheme } from '../src/index';

const context = (overrides: Partial<ThemeContext> = {}): ThemeContext => ({
  storeName: '織日選物',
  storeId: 'woven-day',
  currency: 'TWD',
  locale: 'zh-TW',
  publicUrl: 'https://woven-day.example.test',
  supportEmail: 'hello@woven-day.example.test',
  options: { accentColor: '#8C3E28', tagline: '日常用品，認真挑選。', showSku: true },
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
  lines: [{ sku: 'WD-001', name: '日常托盤', quantity: 1, lineTotalCents: 118_000 }],
};

describe('Default Theme 的商品瀏覽切片', () => {
  it('以 ThemeProductView 的資料建立可連到商品頁的型錄，且使用同源字型資產', () => {
    const html = defaultTheme.renderHome(context(), { products: [product] });

    expect(html).toContain('class="catalog-page"');
    expect(html).toContain('class="product-card"');
    expect(html).toContain('href="/p/product-1"');
    expect(html).toContain('真實商品資料提供的描述。');
    expect(html).toContain('可售 3 件');
    expect(html).toContain('@font-face');
    expect(defaultTheme.staticAssets).toEqual({ prefix: '/theme/default/' });
    expect(html).toContain('/theme/default/fonts/NotoSansTC-Variable.woff2');
    expect(html).toContain('/theme/default/fonts/NotoSerifTC-Variable.woff2');
    expect(html).not.toContain('fonts.googleapis.com');
  });

  it('保留商品詳情的真實加車表單、session CSRF 與庫存上限', () => {
    const html = defaultTheme.renderProduct(context({ csrfToken: 'csrf-token' }), { product });

    expect(html).toContain('class="product-page"');
    expect(html).toContain('action="/cart/items"');
    expect(html).toContain('name="productId" value="product-1"');
    expect(html).toContain('name="_csrf" value="csrf-token"');
    expect(html).toContain('name="quantity" value="1" min="1" max="3" required');
    expect(html).toContain('加入購物車');
  });

  it('售罄時不產生無效的加車表單，訪客也不被要求不存在的 CSRF token', () => {
    const soldOut = defaultTheme.renderProduct(context(), {
      product: { ...product, available: 0 },
    });
    const untracked = defaultTheme.renderProduct(context(), {
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
    const soldOut = defaultTheme.renderProduct(context(), { product: { ...product, available: 0 } });
    const overAvailable = defaultTheme.renderCart(context(), {
      ...cart,
      lines: [{ ...cart.lines[0], quantity: 5, available: 3 }],
    });
    const untracked = defaultTheme.renderCart(context(), {
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
    const html = defaultTheme.renderCart(context({ customerName: '小美', csrfToken: 'csrf-token' }), cart);

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
    const empty = defaultTheme.renderCart(context(), { ...cart, lines: [] });
    const checkout = defaultTheme.renderCheckout(context({ customerName: '小美', csrfToken: 'csrf-token' }), {
      ...cart,
      customerEmail: 'buyer@example.test',
    });

    expect(empty).toContain('購物車是空的');
    expect(empty).toContain('href="/">返回商品列表</a>');
    expect(checkout).toContain('class="checkout-layout"');
    expect(checkout).toContain('buyer@example.test');
    expect(checkout).toContain('action="/checkout"');
    expect(checkout).toContain('name="cartId" value="cart-1"');
    expect(checkout).toContain('name="confirm" value="1"');
    expect(checkout).toContain('name="_csrf" value="csrf-token"');
    expect(checkout).toContain('建立訂單');
    expect(checkout).not.toContain('action="/cart/items/product-1"');
  });

  it('讓帳戶存取與個人資料沿用同一套頁面結構，而不改變欄位名稱', () => {
    const login = defaultTheme.renderAuth(context(), { mode: 'login', next: '/checkout', error: '登入失敗' });
    const profile = defaultTheme.renderAccountProfile(context({ customerName: '小美', csrfToken: 'csrf-token' }), {
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
    const known = defaultTheme.renderOrder(context(), { order });
    const unknown = defaultTheme.renderOrder(context(), { order: { ...order, status: 'refunded' } });

    expect(known).toContain('付款完成');
    expect(unknown).toContain('>refunded</span>');
    expect(unknown).not.toContain('已退款');
  });

  it('使用指定的表面色與可預期的置頂頁首層級', () => {
    const html = defaultTheme.renderHome(context(), { products: [product] });

    expect(html).toContain('--surface-raised: #fffdfc;');
    expect(html).toContain('position: sticky;');
    expect(html).toContain('z-index: 5;');
    expect(html).toContain('top: 0;');
    expect(html).toContain('color: var(--state-danger-ink); background: var(--state-danger-surface);');
  });
});
