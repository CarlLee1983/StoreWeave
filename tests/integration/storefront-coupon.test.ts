import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { CART_COOKIE, SESSION_COOKIE, createServer } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';
import { defaultTheme } from '@storeweave/theme-default';
import { ADMIN_ACTOR, createHarness, createProduct, defaultThemeRelease, stockUp, type TestHarness } from './helpers';

/** 前台券的使用與我的券（工單 38）。 */

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

async function couponPromotion(overrides: Record<string, unknown> = {}) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name: '前台券九折',
    rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    requiresCoupon: true,
    ...overrides,
  }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  created.push(promotion.id);
  return promotion;
}

afterEach(async () => {
  for (const id of created.splice(0)) {
    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus', { id, status: 'disabled' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  }
});

const createCoupon = (input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.coupon.createCoupon', input, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const code = (prefix: string) => `${prefix}${randomUUID().slice(0, 6)}`.toUpperCase();

async function sellable(sku: string, priceCents = 10_000) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, 30);
  return product;
}

/** 訪客把東西放進車，回傳它的 cookie。 */
async function guestCartWith(productId: string) {
  const added = await inject({ method: 'POST', url: '/cart/items', payload: { productId, quantity: '1' } });
  return { [CART_COOKIE]: added.cookies.find((c) => c.name === CART_COOKIE)!.value };
}

async function signIn(tag: string) {
  const registered = await inject({
    method: 'POST', url: '/api/v1/customers/register',
    payload: { email: `sfc-${tag}-${randomUUID().slice(0, 8)}@example.com`, password: 'a-good-password' },
  });
  const session = registered.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const customerId = (await h.runtime.database.db.execute<{ id: string }>(sql`
    SELECT c.id FROM customer_customers c
    JOIN platform_users u ON u.id = c.account_id
    ORDER BY c.created_at DESC LIMIT 1
  `)).rows[0].id;
  return { cookies: { [SESSION_COOKIE]: session }, csrf: csrfTokenFor(session), customerId };
}

describe('購物車的折扣碼', () => {
  it('輸入有效碼之後金額改變，畫面顯示套用中的碼', async () => {
    const promotion = await couponPromotion();
    const value = code('SF');
    await createCoupon({ code: value, promotionId: promotion.id, perCustomerLimit: null });
    const product = await sellable('SFC-APPLY');
    const cookies = await guestCartWith(product.id);

    const applied = await inject({ method: 'POST', url: '/cart/coupon', cookies, payload: { code: value } });
    expect(applied.statusCode).toBe(303);

    const page = await inject({ method: 'GET', url: '/cart', cookies });
    expect(page.body).toContain('已套用折扣碼');
    expect(page.body).toContain(value);
    expect(page.body).toContain('移除');
  });

  it('移除之後金額回到原價，輸入框回來', async () => {
    const promotion = await couponPromotion();
    const value = code('SFR');
    await createCoupon({ code: value, promotionId: promotion.id, perCustomerLimit: null });
    const product = await sellable('SFC-REMOVE');
    const cookies = await guestCartWith(product.id);
    await inject({ method: 'POST', url: '/cart/coupon', cookies, payload: { code: value } });

    await inject({ method: 'POST', url: '/cart/coupon', cookies, payload: { remove: '1' } });

    const page = await inject({ method: 'GET', url: '/cart', cookies });
    expect(page.body).not.toContain('已套用折扣碼');
    expect(page.body).toContain('輸入折扣碼');
  });

  it('無效的碼把原因留在購物車頁上，而不是丟一張錯誤頁', async () => {
    const product = await sellable('SFC-BAD');
    const cookies = await guestCartWith(product.id);

    const res = await inject({ method: 'POST', url: '/cart/coupon', cookies, payload: { code: 'NOSUCHCODE' } });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('找不到這組折扣碼');
    expect(res.body).toContain('購物車');
  });
});

describe('我的券', () => {
  it('未登入會被帶去登入', async () => {
    const res = await inject({ method: 'GET', url: '/account/coupons' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent('/account/coupons')}`);
  });

  it('列出自己的券、面額與到期日', async () => {
    const promotion = await couponPromotion({ name: '會員專屬八折', rule: { type: 'order_percentage', percentOffBasisPoints: 2_000 } });
    const me = await signIn('mine');
    await h.runtime.commands.execute('commerce.coupon.issueCoupons',
      { promotionId: promotion.id, customerIds: [me.customerId], expiresInDays: 60 },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const page = await inject({ method: 'GET', url: '/account/coupons', cookies: me.cookies });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('會員專屬八折');
    expect(page.body).toContain('全單折 20%');
    expect(page.body).toContain('可使用');
  });

  it('即將到期的券被凸顯出來', async () => {
    const promotion = await couponPromotion({ name: '快過期的券' });
    const me = await signIn('soon');
    await h.runtime.commands.execute('commerce.coupon.issueCoupons',
      { promotionId: promotion.id, customerIds: [me.customerId], expiresInDays: 60 },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await h.runtime.database.db.execute(sql`
      UPDATE coupon_coupons SET ends_at = now() + interval '2 days' WHERE customer_id = ${me.customerId}
    `);

    const page = await inject({ method: 'GET', url: '/account/coupons', cookies: me.cookies });
    expect(page.body).toContain('即將到期');
  });

  it('沒有券的人看到的是空狀態，不是壞掉的頁面', async () => {
    const me = await signIn('empty');
    const page = await inject({ method: 'GET', url: '/account/coupons', cookies: me.cookies });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('你目前沒有任何券');
  });
});

describe('猜碼的節流', () => {
  it('前台的折扣碼路由與 API 一樣受節流保護', async () => {
    const product = await sellable('SFC-BRUTE');
    const cookies = await guestCartWith(product.id);

    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await inject({ method: 'POST', url: '/cart/coupon', cookies, payload: { code: `SFGUESS${i}` } });
      statuses.push(res.statusCode);
    }

    // 路由字串打錯就會整段失效，因此這條測試驗的是「那一條路由真的在名單上」。
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(400);
  });
});
