import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CART_COOKIE, SESSION_COOKIE, createServer } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, createProduct, defaultThemeRelease, stockUp, type TestHarness } from './helpers';

/** 前台購物車與結帳頁（工單 29）。 */

let h: TestHarness;
let app: NestFastifyApplication;

beforeAll(async () => {
  h = await createHarness();
  app = await createServer({ runtime: h.runtime, theme: defaultTheme, release: defaultThemeRelease() });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

const inject = (options: Parameters<NestFastifyApplication['inject']>[0]) => app.inject(options);

const created: string[] = [];
const createPromotion = async (input: Record<string, unknown>) => {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', input,
    { actor: ADMIN_ACTOR, idempotencyKey: `promo-${created.length}-${Date.now()}` });
  created.push(promotion.id);
  return promotion;
};

async function disablePromotions() {
  for (const id of created.splice(0)) {
    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus', { id, status: 'disabled' },
      { actor: ADMIN_ACTOR, idempotencyKey: `disable-${id}` });
  }
}

async function sellable(sku: string, priceCents = 5_000) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, 30);
  return product;
}

/** 註冊一位顧客並回傳它的 cookie 與 CSRF header。 */
async function signIn(tag: string) {
  const registered = await inject({
    method: 'POST', url: '/api/v1/customers/register',
    payload: { email: `sf-${tag}-${Date.now()}@example.com`, password: 'a-good-password' },
  });
  const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  return { cookies: { [SESSION_COOKIE]: session }, headers: { 'x-csrf-token': csrfTokenFor(session) }, session };
}

describe('商品頁與購物車頁', () => {
  it('商品頁的動作是加入購物車，不是立即結帳', async () => {
    const product = await sellable('SF-CTA');
    const page = await inject({ method: 'GET', url: `/p/${product.id}` });

    expect(page.body).toContain('action="/cart/items"');
    expect(page.body).toContain('加入購物車');
    expect(page.body).not.toContain('立即結帳');
  });

  it('訪客加入購物車後，購物車頁列出商品行與金額', async () => {
    const product = await sellable('SF-GUEST', 12_300);
    const added = await inject({
      method: 'POST', url: '/cart/items', payload: { productId: product.id, quantity: 2 },
    });
    expect(added.statusCode).toBe(303);
    expect(added.headers.location).toBe('/cart');

    const cookie = added.cookies.find((c) => c.name === CART_COOKIE)!.value;
    const page = await inject({ method: 'GET', url: '/cart', cookies: { [CART_COOKIE]: cookie } });

    expect(page.body).toContain('SF-GUEST');
    expect(page.body).toContain('登入後結帳');
  });

  it('購物車頁可以改數量、也可以移除', async () => {
    const product = await sellable('SF-EDIT');
    const added = await inject({ method: 'POST', url: '/cart/items', payload: { productId: product.id, quantity: 1 } });
    const cookies = { [CART_COOKIE]: added.cookies.find((c) => c.name === CART_COOKIE)!.value };

    await inject({ method: 'POST', url: `/cart/items/${product.id}`, cookies, payload: { quantity: '4' } });
    expect((await inject({ method: 'GET', url: '/cart', cookies })).body).toContain('value="4"');

    await inject({ method: 'POST', url: `/cart/items/${product.id}`, cookies, payload: { quantity: '0' } });
    expect((await inject({ method: 'GET', url: '/cart', cookies })).body).toContain('購物車是空的');
  });

  it('快到滿額門檻時說得出還差多少', async () => {
    await createPromotion({
      name: '滿千折百', rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    });
    try {
      const product = await sellable('SF-HINT', 60_000);
      const added = await inject({ method: 'POST', url: '/cart/items', payload: { productId: product.id, quantity: 1 } });
      const cookies = { [CART_COOKIE]: added.cookies.find((c) => c.name === CART_COOKIE)!.value };

      const page = await inject({ method: 'GET', url: '/cart', cookies });
      expect(page.body).toContain('滿千折百');
      expect(page.body).toMatch(/再買.*400/);
    } finally {
      await disablePromotions();
    }
  });

  it('折扣成立時，購物車頁顯示折扣明細與折後總額', async () => {
    await createPromotion({
      name: '全站九折', rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    try {
      const product = await sellable('SF-DISCOUNT', 10_000);
      const added = await inject({ method: 'POST', url: '/cart/items', payload: { productId: product.id, quantity: 1 } });
      const cookies = { [CART_COOKIE]: added.cookies.find((c) => c.name === CART_COOKIE)!.value };

      const page = await inject({ method: 'GET', url: '/cart', cookies });
      expect(page.body).toContain('全站九折');
      expect(page.body).toContain('預估總額');
    } finally {
      await disablePromotions();
    }
  });
});

describe('結帳流程', () => {
  it('未登入按下結帳會被帶去登入，登入後回到結帳', async () => {
    const res = await inject({ method: 'GET', url: '/checkout' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent('/checkout')}`);
  });

  it('會員走完整條結帳流程並導向訂單頁', async () => {
    const product = await sellable('SF-FLOW', 7_000);
    const auth = await signIn('flow');

    await inject({ method: 'POST', url: '/cart/items', ...auth, payload: { productId: product.id, quantity: 2 } });

    const confirm = await inject({ method: 'GET', url: '/checkout', cookies: auth.cookies });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('確認訂單');
    expect(confirm.body).toContain('SF-FLOW');

    const cartId = /name="cartId" value="([^"]+)"/.exec(confirm.body)![1];
    const placed = await inject({ method: 'POST', url: '/checkout', ...auth, payload: { cartId } });

    expect(placed.statusCode).toBe(303);
    expect(placed.headers.location).toMatch(/^\/orders\//);

    // 結完帳看到的是空車。
    expect((await inject({ method: 'GET', url: '/cart', cookies: auth.cookies })).body).toContain('購物車是空的');
  });

  it('重複送出同一台車的結帳只會有一張訂單', async () => {
    const product = await sellable('SF-DOUBLE', 3_000);
    const auth = await signIn('double');
    await inject({ method: 'POST', url: '/cart/items', ...auth, payload: { productId: product.id, quantity: 1 } });

    const confirm = await inject({ method: 'GET', url: '/checkout', cookies: auth.cookies });
    const cartId = /name="cartId" value="([^"]+)"/.exec(confirm.body)![1];

    const first = await inject({ method: 'POST', url: '/checkout', ...auth, payload: { cartId } });
    const second = await inject({ method: 'POST', url: '/checkout', ...auth, payload: { cartId } });

    expect(second.headers.location).toBe(first.headers.location);
  });

  it('空車進不了確認頁', async () => {
    const auth = await signIn('emptycart');
    const res = await inject({ method: 'GET', url: '/checkout', cookies: auth.cookies });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/cart');
  });
});

describe('買不到的商品要說出來（Spec 0003 User Story 11）', () => {
  it('購物車頁列出被移除的商品，而不是讓它無聲消失', async () => {
    const product = await sellable('SF-REMOVED', 8_000);
    const added = await inject({ method: 'POST', url: '/cart/items', payload: { productId: product.id, quantity: '1' } });
    const cookies = { [CART_COOKIE]: added.cookies.find((c) => c.name === CART_COOKIE)!.value };

    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: product.id, status: 'archived' }, { actor: ADMIN_ACTOR, idempotencyKey: `arch-${product.id}` });

    const page = await inject({ method: 'GET', url: '/cart', cookies });

    expect(page.body).toContain('已經買不到');
    expect(page.body).toContain('SF-REMOVED');
  });

  it('購物車頁有清空的出口——顧客卡住時唯一的自救手段', async () => {
    const product = await sellable('SF-CLEAR', 3_000);
    const added = await inject({ method: 'POST', url: '/cart/items', payload: { productId: product.id, quantity: '1' } });
    const cookies = { [CART_COOKIE]: added.cookies.find((c) => c.name === CART_COOKIE)!.value };

    expect((await inject({ method: 'GET', url: '/cart', cookies })).body).toContain('action="/cart/clear"');

    const cleared = await inject({ method: 'POST', url: '/cart/clear', cookies });
    expect(cleared.statusCode).toBe(303);
    expect((await inject({ method: 'GET', url: '/cart', cookies })).body).toContain('購物車是空的');
  });
});
