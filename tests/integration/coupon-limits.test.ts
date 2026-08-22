import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 限量與每人限用一次（工單 32）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

async function couponPromotion(overrides: Record<string, unknown> = {}) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name: '限量券九折',
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

const applyCoupon = (input: Record<string, unknown>, actor: any) =>
  h.runtime.commands.execute<any>('commerce.cart.applyCoupon', input, { actor, idempotencyKey: randomUUID() });

const addToCart = (input: Record<string, unknown>, actor: any) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', input, { actor, idempotencyKey: randomUUID() });

const getCart = (actor: any) => h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor });

const checkout = (actor: any, cartId: string) =>
  h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId }, { actor, idempotencyKey: randomUUID() });

const code = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`.toUpperCase();

async function sellable(sku: string, priceCents = 10_000) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, 200);
  return product;
}

/** 一位手上有東西、也套好券的顧客。 */
async function readyToCheckout(tag: string, product: any, couponCode?: string) {
  const customer = await createCustomer(h.runtime, { email: `lim-${tag}-${randomUUID()}@example.test` });
  await addToCart({ productId: product.id, quantity: 1 }, customer);
  if (couponCode) await applyCoupon({ code: couponCode }, customer);
  return { customer, cartId: (await getCart(customer)).id };
}

const redeemedCount = async (couponCode: string) => {
  const row = await h.runtime.queries.execute<any>('commerce.coupon.getCoupon', { code: couponCode }, { actor: ADMIN_ACTOR });
  return row.redeemedCount;
};

describe('總量限制', () => {
  it('額度用完之後結帳失敗，而且說得出是券的問題', async () => {
    const promotion = await couponPromotion();
    const value = code('LIMIT1');
    await createCoupon({ code: value, promotionId: promotion.id, maxRedemptions: 1, perCustomerLimit: null });
    const product = await sellable(`LIM-ONE-${randomUUID().slice(0, 6)}`);

    // 兩個人都在額度還在的時候把券套上車——套用不鎖額度。
    const first = await readyToCheckout('first', product, value);
    const second = await readyToCheckout('second', product, value);

    await checkout(first.customer, first.cartId);
    expect(await redeemedCount(value)).toBe(1);

    await expect(checkout(second.customer, second.cartId))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'used_up' } });

    // 搶輸就整張單失敗：顧客看到的金額與實際成交金額因此永遠一致。
    const orders = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${second.customer.customerId}
    `);
    expect(orders.rows[0].count).toBe('0');
  });

  it('併發湧入時只有額度內的成功，總量不超發', async () => {
    const promotion = await couponPromotion({ name: '限量三張' });
    const value = code('RUSH');
    await createCoupon({ code: value, promotionId: promotion.id, maxRedemptions: 3, perCustomerLimit: null });
    const product = await sellable(`LIM-RUSH-${randomUUID().slice(0, 6)}`);

    const shoppers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => readyToCheckout(`rush-${i}`, product, value)),
    );

    const results = await Promise.allSettled(shoppers.map((s) => checkout(s.customer, s.cartId)));
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(5);
    expect(await redeemedCount(value)).toBe(3);

    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM coupon_redemptions WHERE code = ${value}
    `);
    expect(rows.rows[0].count).toBe('3');
  });

  it('額度已經用完的碼，套用當下就說得出來——不必等到結帳才失望', async () => {
    const promotion = await couponPromotion();
    const value = code('GONE');
    await createCoupon({ code: value, promotionId: promotion.id, maxRedemptions: 1, perCustomerLimit: null });
    const product = await sellable(`LIM-GONE-${randomUUID().slice(0, 6)}`);

    const first = await readyToCheckout('gone-first', product, value);
    await checkout(first.customer, first.cartId);

    const late = await createCustomer(h.runtime, { email: `lim-late-${randomUUID()}@example.test` });
    await addToCart({ productId: product.id, quantity: 1 }, late);
    await expect(applyCoupon({ code: value }, late))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'used_up' } });
  });

  it('試算階段不扣額度：看得到折扣不等於結得了帳，而訊息要講出這件事', async () => {
    const promotion = await couponPromotion();
    const value = code('HONEST');
    await createCoupon({ code: value, promotionId: promotion.id, maxRedemptions: 1, perCustomerLimit: null });
    const product = await sellable(`LIM-HONEST-${randomUUID().slice(0, 6)}`);

    const a = await readyToCheckout('honest-a', product, value);
    const b = await readyToCheckout('honest-b', product, value);
    // 兩個人都在試算裡看得到折扣——額度還沒被任何人鎖住。
    expect((await getCart(b.customer)).discountCents).toBe(1_000);

    await checkout(a.customer, a.cartId);

    await expect(checkout(b.customer, b.cartId)).rejects.toThrow(/試算時不會保留額度/);
  });
});

describe('每人限用', () => {
  it('同一個會員對同一條規則只能核銷一次', async () => {
    const promotion = await couponPromotion();
    const value = code('ONCE');
    await createCoupon({ code: value, promotionId: promotion.id });
    const product = await sellable(`LIM-ONCE-${randomUUID().slice(0, 6)}`);

    const { customer, cartId } = await readyToCheckout('once', product, value);
    await checkout(customer, cartId);

    await addToCart({ productId: product.id, quantity: 1 }, customer);
    await applyCoupon({ code: value }, customer);
    const second = (await getCart(customer)).id;

    await expect(checkout(customer, second))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'already_redeemed' } });
  });

  it('限制看的是規則而不是碼：同一檔活動的兩組碼不能被同一個人各用一次', async () => {
    const promotion = await couponPromotion();
    const first = code('RULE-A');
    const second = code('RULE-B');
    await createCoupon({ code: first, promotionId: promotion.id });
    await createCoupon({ code: second, promotionId: promotion.id });
    const product = await sellable(`LIM-RULE-${randomUUID().slice(0, 6)}`);

    const shopper = await readyToCheckout('rule', product, first);
    await checkout(shopper.customer, shopper.cartId);

    await addToCart({ productId: product.id, quantity: 1 }, shopper.customer);
    await applyCoupon({ code: second }, shopper.customer);
    await expect(checkout(shopper.customer, (await getCart(shopper.customer)).id))
      .rejects.toMatchObject({ details: { reason: 'already_redeemed' } });
  });

  it('明確關掉每人限制時，同一個人可以再用一次', async () => {
    const promotion = await couponPromotion();
    const value = code('UNLIMITED');
    await createCoupon({ code: value, promotionId: promotion.id, perCustomerLimit: null });
    const product = await sellable(`LIM-UNL-${randomUUID().slice(0, 6)}`);

    const shopper = await readyToCheckout('unlimited', product, value);
    await checkout(shopper.customer, shopper.cartId);

    await addToCart({ productId: product.id, quantity: 1 }, shopper.customer);
    await applyCoupon({ code: value }, shopper.customer);
    const order = await checkout(shopper.customer, (await getCart(shopper.customer)).id);

    expect(order.discountCents).toBe(1_000);
    expect(await redeemedCount(value)).toBe(2);
  });
});
