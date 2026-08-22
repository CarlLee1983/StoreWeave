import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 行銷分析的數字（工單 47）。資料來自核銷明細，不掃訂單全表。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

async function couponPromotion(name: string, basisPoints: number) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name,
    rule: { type: 'order_percentage', percentOffBasisPoints: basisPoints },
    requiresCoupon: true,
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

const performance = (input: Record<string, unknown> = {}) =>
  h.runtime.queries.execute<any>('commerce.coupon.promotionPerformance', input, { actor: ADMIN_ACTOR });

const code = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`.toUpperCase();

async function buyWith(couponCode: string, priceCents: number) {
  const customer = await createCustomer(h.runtime, { email: `an-${randomUUID()}@example.test` });
  const product = await createProduct(h.runtime, { sku: `AN-${randomUUID().slice(0, 8)}`, name: 'an', priceCents });
  await stockUp(h.runtime, product.id, 10);
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
    { actor: customer, idempotencyKey: randomUUID() });
  await h.runtime.commands.execute('commerce.cart.applyCoupon', { code: couponCode },
    { actor: customer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor: customer });
  return h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId: cart.id },
    { actor: customer, idempotencyKey: randomUUID() });
}

describe('活動成效', () => {
  it('核銷次數、訂單數、折抵總額與營收都對得起來', async () => {
    const promotion = await couponPromotion(`成效測試-${randomUUID().slice(0, 6)}`, 1_000);
    const value = code('PERF');
    await h.runtime.commands.execute('commerce.coupon.createCoupon',
      { code: value, promotionId: promotion.id, perCustomerLimit: null },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    await buyWith(value, 100_000);
    await buyWith(value, 50_000);

    const item = (await performance()).items.find((i: any) => i.promotionId === promotion.id);
    expect(item).toMatchObject({
      name: promotion.name,
      redemptionCount: 2,
      orderCount: 2,
      discountCents: 15_000,
      revenueCents: 135_000,
    });
  });

  it('回沖過的核銷不算成效', async () => {
    const promotion = await couponPromotion(`回沖測試-${randomUUID().slice(0, 6)}`, 1_000);
    const value = code('PERFREV');
    await h.runtime.commands.execute('commerce.coupon.createCoupon',
      { code: value, promotionId: promotion.id, perCustomerLimit: null },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const order = await buyWith(value, 100_000);
    await buyWith(value, 100_000);
    await h.runtime.commands.execute('commerce.order.cancelOrder', { orderId: order.id, reason: 'test' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const item = (await performance()).items.find((i: any) => i.promotionId === promotion.id);
    expect(item.orderCount).toBe(1);
  });

  it('可以限定期間', async () => {
    const promotion = await couponPromotion(`期間測試-${randomUUID().slice(0, 6)}`, 1_000);
    const value = code('PERFWIN');
    await h.runtime.commands.execute('commerce.coupon.createCoupon',
      { code: value, promotionId: promotion.id, perCustomerLimit: null },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await buyWith(value, 10_000);

    const future = await performance({ from: new Date(Date.now() + 86_400_000) });
    expect(future.items.find((i: any) => i.promotionId === promotion.id)).toBeUndefined();
  });

  it('沒有核銷的活動不會出現在成效表裡——那張表講的是花出去的錢', async () => {
    const promotion = await couponPromotion(`沒人用-${randomUUID().slice(0, 6)}`, 1_000);

    expect((await performance()).items.find((i: any) => i.promotionId === promotion.id)).toBeUndefined();
  });
});

describe('流通在外的購物金', () => {
  it('已生效與未生效分開算', async () => {
    const customer = await createCustomer(h.runtime, { email: `an-out-${randomUUID()}@example.test` });
    await h.runtime.commands.execute('commerce.loyalty.adjustRewards',
      { customerId: customer.customerId, amountCents: 4_321, reason: '流通測試' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const result = await h.runtime.queries.execute<any>('commerce.loyalty.outstandingRewards', {}, { actor: ADMIN_ACTOR });

    expect(result.availableCents).toBeGreaterThanOrEqual(4_321);
    expect(result.customerCount).toBeGreaterThan(0);
  });
});
