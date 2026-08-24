import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, checkoutInput, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 優惠券模型與公開共用碼（工單 31）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

/** 券所指向的活動一律 requiresCoupon：否則建一張券就等於全站打折。 */
async function couponPromotion(overrides: Record<string, unknown> = {}) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name: '券用九折',
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

const applyCoupon = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.applyCoupon', input, { actor, idempotencyKey: randomUUID() });

const removeCoupon = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.removeCoupon', input, { actor, idempotencyKey: randomUUID() });

const addToCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', input, { actor, idempotencyKey: randomUUID() });

const getCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.cart.getCart', input, { actor });

const checkout = (actor: any, cartId: string) =>
  h.runtime.commands.execute<any>('commerce.order.checkoutCart', checkoutInput(h, cartId), { actor, idempotencyKey: randomUUID() });

async function sellable(sku: string, priceCents = 10_000) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, 30);
  return product;
}

const buyer = (tag: string) => createCustomer(h.runtime, { email: `coupon-${tag}-${randomUUID()}@example.test` });
const code = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`.toUpperCase();

/** 一位有東西在車上的顧客。 */
async function shopper(tag: string, priceCents = 10_000) {
  const customer = await buyer(tag);
  const product = await sellable(`CPN-${tag}-${randomUUID().slice(0, 6)}`, priceCents);
  await addToCart({ productId: product.id, quantity: 1 }, customer);
  return { customer, product };
}

describe('券的模型', () => {
  it('券指向一條促銷規則，有唯一的碼、狀態與有效期間', async () => {
    const promotion = await couponPromotion();
    const value = code('SUMMER');
    const coupon = await createCoupon({ code: value, promotionId: promotion.id });

    expect(coupon).toMatchObject({ code: value, promotionId: promotion.id, status: 'issued', customerId: null });

    await expect(createCoupon({ code: value.toLowerCase(), promotionId: promotion.id }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('需要券的活動不會人人適用', async () => {
    const promotion = await couponPromotion({ name: '不該人人適用的九折' });
    const { customer } = await shopper('nofree');

    const cart = await getCart({}, customer);
    expect(cart.discountCents).toBe(0);
    expect(cart.adjustments).toEqual([]);
    expect(promotion.requiresCoupon).toBe(true);
  });
});

describe('顧客輸入折扣碼', () => {
  it('有效的碼會折價，而且大小寫不影響', async () => {
    const promotion = await couponPromotion();
    const value = code('OFF10');
    await createCoupon({ code: value, promotionId: promotion.id });
    const { customer } = await shopper('apply');

    const cart = await applyCoupon({ code: value.toLowerCase() }, customer);

    expect(cart.discountCents).toBe(1_000);
    expect(cart.totalCents).toBe(9_000);
    expect(cart.coupon).toMatchObject({ code: value, promotionId: promotion.id, discountCents: 1_000 });
    expect(cart.couponError).toBeNull();
  });

  it('移除折扣碼之後金額回到原價', async () => {
    const promotion = await couponPromotion();
    const value = code('REMOVE');
    await createCoupon({ code: value, promotionId: promotion.id });
    const { customer } = await shopper('remove');
    await applyCoupon({ code: value }, customer);

    const cart = await removeCoupon({}, customer);

    expect(cart.coupon).toBeNull();
    expect(cart.discountCents).toBe(0);
    expect(cart.totalCents).toBe(10_000);
  });

  it('無效的原因分得出來：不存在、已過期、已停用、不符資格', async () => {
    const promotion = await couponPromotion();
    const { customer } = await shopper('reasons');

    await expect(applyCoupon({ code: code('NOPE') }, customer))
      .rejects.toMatchObject({ code: 'NOT_FOUND', details: { reason: 'not_found' } });

    const expired = code('EXPIRED');
    await createCoupon({
      code: expired, promotionId: promotion.id,
      startsAt: new Date(Date.now() - 2 * 86_400_000), endsAt: new Date(Date.now() - 86_400_000),
    });
    await expect(applyCoupon({ code: expired }, customer))
      .rejects.toMatchObject({ details: { reason: 'expired' } });

    const future = code('FUTURE');
    await createCoupon({ code: future, promotionId: promotion.id, startsAt: new Date(Date.now() + 86_400_000) });
    await expect(applyCoupon({ code: future }, customer))
      .rejects.toMatchObject({ details: { reason: 'not_started' } });

    const disabled = code('DISABLED');
    const row = await createCoupon({ code: disabled, promotionId: promotion.id });
    await h.runtime.commands.execute('commerce.coupon.setCouponStatus', { id: row.id, status: 'void' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await expect(applyCoupon({ code: disabled }, customer))
      .rejects.toMatchObject({ details: { reason: 'void' } });

    const someoneElse = await buyer('owner');
    const owned = code('MINE');
    await createCoupon({ code: owned, promotionId: promotion.id, customerId: someoneElse.customerId });
    await expect(applyCoupon({ code: owned }, customer))
      .rejects.toMatchObject({ details: { reason: 'not_eligible' } });
  });

  it('實發券的擁有者本人用得了', async () => {
    const promotion = await couponPromotion();
    const { customer } = await shopper('owned');
    const value = code('GIFT');
    await createCoupon({ code: value, promotionId: promotion.id, customerId: customer.customerId });

    expect((await applyCoupon({ code: value }, customer)).discountCents).toBe(1_000);
  });

  it('套用之後才過期的券，購物車說得出原因而不是靜靜恢復原價', async () => {
    const promotion = await couponPromotion();
    const value = code('LATER');
    const coupon = await createCoupon({ code: value, promotionId: promotion.id });
    const { customer } = await shopper('later');
    await applyCoupon({ code: value }, customer);

    await h.runtime.commands.execute('commerce.coupon.setCouponStatus', { id: coupon.id, status: 'void' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const cart = await getCart({}, customer);
    expect(cart.coupon).toBeNull();
    expect(cart.couponError).toContain('停用');
    expect(cart.totalCents).toBe(10_000);
  });
});

describe('核銷', () => {
  it('核銷在結帳的同一個交易內完成，明細寫得出是哪張券、哪條規則、哪張訂單、折多少', async () => {
    const promotion = await couponPromotion();
    const value = code('REDEEM');
    const coupon = await createCoupon({ code: value, promotionId: promotion.id, partnerCode: 'INFLUENCER-A' });
    const { customer } = await shopper('redeem');
    const cart = await applyCoupon({ code: value }, customer);

    const order = await checkout(customer, cart.id);
    expect(order.discountCents).toBe(1_000);

    const rows = await h.runtime.database.db.execute<any>(sql`
      SELECT coupon_id, promotion_id, order_id, customer_id, code, partner_code, discount_cents
      FROM coupon_redemptions WHERE order_id = ${order.id}
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      coupon_id: coupon.id,
      promotion_id: promotion.id,
      order_id: order.id,
      customer_id: customer.customerId,
      code: value,
      partner_code: 'INFLUENCER-A',
      discount_cents: 1_000,
    });
  });

  it('訂單失敗則核銷不成立', async () => {
    const promotion = await couponPromotion();
    const value = code('ROLLBACK');
    await createCoupon({ code: value, promotionId: promotion.id });
    const customer = await buyer('rollback');
    const product = await createProduct(h.runtime, { sku: `CPN-NOSTOCK-${randomUUID().slice(0, 6)}`, name: 'no stock', priceCents: 10_000 });
    await stockUp(h.runtime, product.id, 1);
    await addToCart({ productId: product.id, quantity: 5 }, customer);
    const cart = await applyCoupon({ code: value }, customer);

    await expect(checkout(customer, cart.id)).rejects.toThrow();

    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM coupon_redemptions WHERE code = ${value}
    `);
    expect(rows.rows[0].count).toBe('0');
  });

  it('實發券用掉之後就變成已使用，共用碼還留著', async () => {
    const promotion = await couponPromotion();
    const shared = code('SHARED');
    await createCoupon({ code: shared, promotionId: promotion.id });

    const first = await shopper('shared-1');
    await applyCoupon({ code: shared }, first.customer);
    await checkout(first.customer, (await getCart({}, first.customer)).id);

    const second = await shopper('shared-2');
    expect((await applyCoupon({ code: shared }, second.customer)).discountCents).toBe(1_000);

    const owned = code('ONCE');
    const ownedCoupon = await createCoupon({ code: owned, promotionId: promotion.id, customerId: second.customer.customerId });
    await applyCoupon({ code: owned }, second.customer);
    await checkout(second.customer, (await getCart({}, second.customer)).id);

    const after = await h.runtime.queries.execute<any>('commerce.coupon.getCoupon', { code: owned }, { actor: ADMIN_ACTOR });
    expect(after.status).toBe('used');
    expect(ownedCoupon.status).toBe('issued');
  });

  it('券沒有真的折到錢就不核銷——門檻沒到的券被吃掉是最不能接受的損失', async () => {
    const promotion = await couponPromotion({
      name: '滿五千折五百', rule: { type: 'threshold_fixed_amount', thresholdCents: 500_000, discountCents: 50_000 },
    });
    const value = code('THRESHOLD');
    await createCoupon({ code: value, promotionId: promotion.id });
    const { customer } = await shopper('threshold', 10_000);
    const cart = await applyCoupon({ code: value }, customer);
    expect(cart.discountCents).toBe(0);

    const order = await checkout(customer, cart.id);

    expect(order.discountCents).toBe(0);
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM coupon_redemptions WHERE order_id = ${order.id}
    `);
    expect(rows.rows[0].count).toBe('0');
  });
});
