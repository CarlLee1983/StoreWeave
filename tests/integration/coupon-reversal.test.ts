import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 訂單取消時券回沖（工單 37）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

async function couponPromotion(overrides: Record<string, unknown> = {}) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name: '回沖測試九折',
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

const getCoupon = (code: string) =>
  h.runtime.queries.execute<any>('commerce.coupon.getCoupon', { code }, { actor: ADMIN_ACTOR });

const cancel = (orderId: string) =>
  h.runtime.commands.execute<any>('commerce.order.cancelOrder', { orderId, reason: 'test' },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const code = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`.toUpperCase();

async function sellable() {
  const product = await createProduct(h.runtime, { sku: `REV-${randomUUID().slice(0, 8)}`, name: 'rev', priceCents: 10_000 });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

async function buyWith(couponCode: string, customer?: any) {
  const buyer = customer ?? await createCustomer(h.runtime, { email: `rev-${randomUUID()}@example.test` });
  const product = await sellable();
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
    { actor: buyer, idempotencyKey: randomUUID() });
  await h.runtime.commands.execute('commerce.cart.applyCoupon', { code: couponCode },
    { actor: buyer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor: buyer });
  const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId: cart.id },
    { actor: buyer, idempotencyKey: randomUUID() });
  return { order, buyer };
}

describe('訂單取消時券回沖', () => {
  it('實發券回到可用，總量計數回補', async () => {
    const promotion = await couponPromotion();
    const value = code('REV');
    const customer = await createCustomer(h.runtime, { email: `rev-owner-${randomUUID()}@example.test` });
    await createCoupon({ code: value, promotionId: promotion.id, customerId: customer.customerId, maxRedemptions: 1 });

    const { order } = await buyWith(value, customer);
    expect(await getCoupon(value)).toMatchObject({ status: 'used', redeemedCount: 1 });

    await cancel(order.id);

    expect(await getCoupon(value)).toMatchObject({ status: 'issued', redeemedCount: 0 });
  });

  it('每人使用次數一併回補：取消之後同一個人可以再用一次', async () => {
    const promotion = await couponPromotion();
    const value = code('REVONCE');
    await createCoupon({ code: value, promotionId: promotion.id, perCustomerLimit: 1 });

    const { order, buyer } = await buyWith(value);
    await cancel(order.id);

    const again = await buyWith(value, buyer);
    expect(again.order.discountCents).toBe(1_000);
  });

  it('限量券回沖之後，額度讓給下一個人', async () => {
    const promotion = await couponPromotion();
    const value = code('REVLIMIT');
    await createCoupon({ code: value, promotionId: promotion.id, maxRedemptions: 1, perCustomerLimit: null });

    const { order } = await buyWith(value);
    await cancel(order.id);

    const next = await buyWith(value);
    expect(next.order.discountCents).toBe(1_000);
  });

  it('已過期的券取消後不會變成可用', async () => {
    const promotion = await couponPromotion();
    const value = code('REVEXP');
    const coupon = await createCoupon({ code: value, promotionId: promotion.id });
    const { order, buyer } = await buyWith(value);

    await h.runtime.database.db.execute(sql`
      UPDATE coupon_coupons SET ends_at = now() - interval '1 hour' WHERE id = ${coupon.id}
    `);
    await cancel(order.id);

    const product = await sellable();
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
      { actor: buyer, idempotencyKey: randomUUID() });
    await expect(h.runtime.commands.execute('commerce.cart.applyCoupon', { code: value },
      { actor: buyer, idempotencyKey: randomUUID() })).rejects.toMatchObject({ details: { reason: 'expired' } });
  });

  it('回沖與取消同一個交易：取消失敗時核銷還在', async () => {
    const promotion = await couponPromotion();
    const value = code('REVTX');
    await createCoupon({ code: value, promotionId: promotion.id });
    const { order } = await buyWith(value);

    // 已付款的訂單不能取消——取消失敗，核銷不該被動到。
    await h.runtime.database.db.execute(sql`UPDATE order_orders SET status = 'paid' WHERE id = ${order.id}`);
    await expect(cancel(order.id)).rejects.toThrow();

    expect(await getCoupon(value)).toMatchObject({ redeemedCount: 1 });
    const rows = await h.runtime.database.db.execute<{ reversed_at: string | null }>(sql`
      SELECT reversed_at FROM coupon_redemptions WHERE order_id = ${order.id}
    `);
    expect(rows.rows[0].reversed_at).toBeNull();
  });

  it('回沖過的核銷不再計入行銷成效', async () => {
    const promotion = await couponPromotion();
    const partner = `REVP-${randomUUID().slice(0, 6)}`;
    const value = code('REVATTR');
    await createCoupon({ code: value, promotionId: promotion.id, partnerCode: partner, perCustomerLimit: null });

    const { order } = await buyWith(value);
    await buyWith(value);
    expect((await h.runtime.queries.execute<any>('commerce.coupon.attributionSummary',
      { partnerCode: partner }, { actor: ADMIN_ACTOR })).items[0].orderCount).toBe(2);

    await cancel(order.id);

    expect((await h.runtime.queries.execute<any>('commerce.coupon.attributionSummary',
      { partnerCode: partner }, { actor: ADMIN_ACTOR })).items[0].orderCount).toBe(1);
  });
});
