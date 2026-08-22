import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 工單 31–49 審查抓到的問題的迴歸測試。每一條對應一個具體的損失路徑。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

const createPromotion = async (input: Record<string, unknown>) => {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', input,
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  created.push(promotion.id);
  return promotion;
};

afterEach(async () => {
  for (const id of created.splice(0)) {
    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus', { id, status: 'disabled' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  }
});

const createCoupon = (input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.coupon.createCoupon', input, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const code = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`.toUpperCase();

async function sellable(priceCents: number) {
  const product = await createProduct(h.runtime, { sku: `MH-${randomUUID().slice(0, 8)}`, name: 'mh', priceCents });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

const buyer = (tag: string) => createCustomer(h.runtime, { email: `mh-${tag}-${randomUUID()}@example.test` });

describe('券只能指向需要券的活動', () => {
  it('指向人人適用的活動會被拒絕——否則那檔活動會被套用兩次', async () => {
    const open = await createPromotion({
      name: `人人適用-${randomUUID().slice(0, 6)}`,
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });

    await expect(createCoupon({ code: code('BAD'), promotionId: open.id }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('批次發券同樣擋下', async () => {
    const open = await createPromotion({
      name: `人人適用批次-${randomUUID().slice(0, 6)}`,
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    const customer = await buyer('batch');

    await expect(h.runtime.commands.execute('commerce.coupon.issueCoupons',
      { promotionId: open.id, customerIds: [customer.customerId] },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow();
  });

  it('就算資料庫裡已經有這種券，定價也只套用一次', async () => {
    const open = await createPromotion({
      name: `舊資料九折-${randomUUID().slice(0, 6)}`,
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    const value = code('LEGACY');
    // 繞過命令直接寫進資料表，模擬這道驗證存在之前建立的券。
    await h.runtime.database.db.execute(sql`
      INSERT INTO coupon_coupons (id, code, promotion_id, status, per_customer_limit)
      VALUES (${randomUUID()}, ${value}, ${open.id}, 'issued', NULL)
    `);

    const customer = await buyer('legacy');
    const product = await sellable(10_000);
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
      { actor: customer, idempotencyKey: randomUUID() });
    const cart = await h.runtime.commands.execute<any>('commerce.cart.applyCoupon', { code: value },
      { actor: customer, idempotencyKey: randomUUID() });

    // 九折就是九折：1,000。套兩次會變成 1,900。
    expect(cart.discountCents).toBe(1_000);
    expect(cart.adjustments).toHaveLength(1);

    const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId: cart.id },
      { actor: customer, idempotencyKey: randomUUID() });
    expect(order.discountCents).toBe(1_000);
  });
});

describe('活動的輸入驗證', () => {
  it('拼錯的欄位會被擋下，而不是安靜地建出一檔全站打折的活動', async () => {
    await expect(createPromotion({
      name: '拼錯欄位',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
      requiresCoupons: true,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('自動發券的活動必須是需要券的活動', async () => {
    await expect(createPromotion({
      name: '自動發但人人適用',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
      autoIssue: 'signup',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('改成人人適用卻留著自動發券也被擋下', async () => {
    const promotion = await createPromotion({
      name: `自動發-${randomUUID().slice(0, 6)}`,
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
      requiresCoupon: true,
      autoIssue: 'signup',
    });

    await expect(h.runtime.commands.execute('commerce.promotion.updatePromotion',
      { id: promotion.id, requiresCoupon: false },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('等級重算會輪替', () => {
  it('超過單輪上限的顧客在下一輪被算到，不會永遠停在舊等級', async () => {
    const a = await buyer('rot-a');
    const b = await buyer('rot-b');
    for (const customer of [a, b]) {
      await h.runtime.database.db.execute(sql`
        INSERT INTO loyalty_tier_entries (id, customer_id, points, source, earned_at)
        VALUES (${randomUUID()}, ${customer.customerId}, 5000, 'manual', now())
      `);
    }

    // 一輪只算一位：依「最久沒算過」排序，第二輪必須換人。
    await h.runtime.commands.execute('commerce.loyalty.recalculateTiers', { limit: 1 },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await h.runtime.commands.execute('commerce.loyalty.recalculateTiers', { limit: 1 },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM loyalty_customer_tiers
      WHERE customer_id IN (${a.customerId}, ${b.customerId})
    `);
    expect(rows.rows[0].count).toBe('2');
  });
});

describe('用掉的券不能被改回可用', () => {
  it('setCouponStatus 拒絕動已使用的券', async () => {
    const promotion = await createPromotion({
      name: `回收測試-${randomUUID().slice(0, 6)}`,
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
      requiresCoupon: true,
    });
    const customer = await buyer('used');
    const value = code('USED');
    const coupon = await createCoupon({ code: value, promotionId: promotion.id, customerId: customer.customerId });

    const product = await sellable(10_000);
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
      { actor: customer, idempotencyKey: randomUUID() });
    const cart = await h.runtime.commands.execute<any>('commerce.cart.applyCoupon', { code: value },
      { actor: customer, idempotencyKey: randomUUID() });
    await h.runtime.commands.execute('commerce.order.checkoutCart', { cartId: cart.id },
      { actor: customer, idempotencyKey: randomUUID() });

    await expect(h.runtime.commands.execute('commerce.coupon.setCouponStatus',
      { id: coupon.id, status: 'issued' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('手動調整的金額有界線', () => {
  it('超出上限被擋下', async () => {
    const customer = await buyer('bounds');

    await expect(h.runtime.commands.execute('commerce.loyalty.adjustRewards',
      { customerId: customer.customerId, amountCents: 2_000_000_000, reason: '超額' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('結帳的商品行數有上限', () => {
  it('購物車塞超過上限時，結帳明確失敗而不是拖著整個交易', async () => {
    const customer = await buyer('toomany');
    const cartId = (await h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor: customer })).id;
    const product = await sellable(100);
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
      { actor: customer, idempotencyKey: randomUUID() });
    const realCartId = (await h.runtime.queries.execute<any>('commerce.cart.getCart', {}, { actor: customer })).id;
    expect(realCartId).not.toBe(cartId);

    // 直接塞進 51 件不同商品，超過 placeOrderInput 宣告的上限。
    for (let i = 0; i < 51; i += 1) {
      const extra = await sellable(100);
      await h.runtime.database.db.execute(sql`
        INSERT INTO cart_items (id, cart_id, product_id, quantity)
        VALUES (${randomUUID()}, ${realCartId}, ${extra.id}, 1)
      `);
    }

    await expect(h.runtime.commands.execute('commerce.order.checkoutCart', { cartId: realCartId },
      { actor: customer, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
