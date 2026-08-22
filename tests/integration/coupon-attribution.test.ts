import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 行銷碼與訂單歸因（工單 36）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

async function couponPromotion(overrides: Record<string, unknown> = {}) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name: '行銷碼九折',
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

const attribution = (input: Record<string, unknown> = {}) =>
  h.runtime.queries.execute<any>('commerce.coupon.attributionSummary', input, { actor: ADMIN_ACTOR });

const code = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`.toUpperCase();

async function sellable(priceCents: number) {
  const product = await createProduct(h.runtime, { sku: `ATTR-${randomUUID().slice(0, 8)}`, name: 'attr', priceCents });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

/** 買一件，可選擇套一組碼。回傳訂單。 */
async function buy(priceCents: number, couponCode?: string) {
  const customer = await createCustomer(h.runtime, { email: `attr-${randomUUID()}@example.test` });
  const product = await sellable(priceCents);
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
    { actor: customer, idempotencyKey: randomUUID() });
  if (couponCode) {
    await h.runtime.commands.execute('commerce.cart.applyCoupon', { code: couponCode },
      { actor: customer, idempotencyKey: randomUUID() });
  }
  const cart = await h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor: customer });
  return h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId: cart.id },
    { actor: customer, idempotencyKey: randomUUID() });
}

describe('行銷碼歸因', () => {
  it('核銷時把訂單歸因給合作夥伴，可依夥伴分組查詢', async () => {
    const promotion = await couponPromotion();
    const partner = `PARTNER-${randomUUID().slice(0, 6)}`;
    const value = code('INFLU');
    await createCoupon({ code: value, promotionId: promotion.id, partnerCode: partner, perCustomerLimit: null });

    await buy(100_000, value);
    await buy(50_000, value);

    const { items } = await attribution({ partnerCode: partner });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      partnerCode: partner,
      orderCount: 2,
      // 折後應付：90,000 + 45,000
      revenueCents: 135_000,
      discountCents: 15_000,
    });
  });

  it('沒有帶歸因的券不會出現在歸因報表裡', async () => {
    const promotion = await couponPromotion();
    const value = code('PLAIN');
    await createCoupon({ code: value, promotionId: promotion.id });
    const order = await buy(30_000, value);

    const rows = await h.runtime.database.db.execute<{ partner_code: string | null }>(sql`
      SELECT partner_code FROM coupon_redemptions WHERE order_id = ${order.id}
    `);
    expect(rows.rows[0].partner_code).toBeNull();
  });

  it('沒有輸入碼就沒有歸因——不看點擊、不種追蹤 cookie', async () => {
    await couponPromotion();
    const order = await buy(20_000);

    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM coupon_redemptions WHERE order_id = ${order.id}
    `);
    expect(rows.rows[0].count).toBe('0');
  });

  it('一張訂單最多一個帶歸因的券，資料庫這一層也擋得住', async () => {
    const promotion = await couponPromotion();
    const first = await createCoupon({ code: code('P1'), promotionId: promotion.id, partnerCode: 'ALPHA' });
    const second = await createCoupon({ code: code('P2'), promotionId: promotion.id, partnerCode: 'BETA' });
    const order = await buy(10_000, first.code);
    const customerId = (await h.runtime.database.db.execute<{ customer_id: string }>(sql`
      SELECT customer_id FROM coupon_redemptions WHERE order_id = ${order.id}
    `)).rows[0].customer_id;

    // 直接往同一張訂單再塞一筆帶歸因的核銷——唯一索引必須擋下來。
    await expect(h.runtime.database.db.execute(sql`
      INSERT INTO coupon_redemptions (id, coupon_id, promotion_id, order_id, customer_id, code, partner_code, discount_cents)
      VALUES (${randomUUID()}, ${second.id}, ${promotion.id}, ${order.id}, ${customerId}, ${second.code}, 'BETA', 100)
    `)).rejects.toThrow();
  });

  it('分組查詢可以限定期間', async () => {
    const promotion = await couponPromotion();
    const partner = `WINDOW-${randomUUID().slice(0, 6)}`;
    const value = code('WIN');
    await createCoupon({ code: value, promotionId: promotion.id, partnerCode: partner, perCustomerLimit: null });
    await buy(10_000, value);

    const future = await attribution({ partnerCode: partner, from: new Date(Date.now() + 86_400_000) });
    expect(future.items).toEqual([]);

    const past = await attribution({ partnerCode: partner, from: new Date(Date.now() - 86_400_000) });
    expect(past.items[0].orderCount).toBe(1);
  });
});
