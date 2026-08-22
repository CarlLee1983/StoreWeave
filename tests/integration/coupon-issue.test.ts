import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 實發券、券碼產生與批次發放（工單 33）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const created: string[] = [];

async function couponPromotion(overrides: Record<string, unknown> = {}) {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', {
    name: '實發券九折',
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

const issue = (input: Record<string, unknown>) =>
  h.runtime.commands.execute<any>('commerce.coupon.issueCoupons', input, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

const listCoupons = (input: Record<string, unknown>) =>
  h.runtime.queries.execute<any>('commerce.coupon.listCoupons', input, { actor: ADMIN_ACTOR });

const applyCoupon = (code: string, actor: any) =>
  h.runtime.commands.execute<any>('commerce.cart.applyCoupon', { code }, { actor, idempotencyKey: randomUUID() });

const addToCart = (productId: string, actor: any) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', { productId, quantity: 1 }, { actor, idempotencyKey: randomUUID() });

const buyer = (tag: string) => createCustomer(h.runtime, { email: `issue-${tag}-${randomUUID()}@example.test` });

async function sellable(sku: string) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents: 10_000 });
  await stockUp(h.runtime, product.id, 20);
  return product;
}

describe('批次發券', () => {
  it('發給指定的會員，每張券各自有碼與到期日，批次追得回來', async () => {
    const promotion = await couponPromotion();
    const a = await buyer('a');
    const b = await buyer('b');

    const result = await issue({
      promotionId: promotion.id,
      customerIds: [a.customerId, b.customerId],
      codePrefix: 'VIP',
      expiresInDays: 30,
    });

    expect(result.issued).toBe(2);
    expect(result.skipped).toBe(0);

    const { items } = await listCoupons({ promotionId: promotion.id });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((c: any) => c.code)).size).toBe(2);
    for (const coupon of items) {
      expect(coupon.code).toMatch(/^VIP-/);
      expect(coupon.customerId).not.toBeNull();
      expect(coupon.batchId).toBe(result.batchId);
      expect(coupon.source).toBe('manual');
      expect(new Date(coupon.endsAt).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('同一批重跑不會發第二張', async () => {
    const promotion = await couponPromotion();
    const customer = await buyer('rerun');

    const first = await issue({ promotionId: promotion.id, customerIds: [customer.customerId] });
    expect(first.issued).toBe(1);

    // 同一批的去重鍵已經在資料庫裡，重跑只會被擋下。
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM coupon_coupons WHERE batch_id = ${first.batchId}
    `);
    expect(rows.rows[0].count).toBe('1');

    const second = await issue({ promotionId: promotion.id, customerIds: [customer.customerId] });
    // 不同批次可以再發一張：那是經營者的意圖，不是錯誤。
    expect(second.issued).toBe(1);
    expect(second.batchId).not.toBe(first.batchId);
  });

  it('不指名對象就是發給全體有效會員', async () => {
    const promotion = await couponPromotion();
    const before = (await listCoupons({ promotionId: promotion.id })).total;
    const customer = await buyer('everyone');

    const result = await issue({ promotionId: promotion.id });

    expect(result.issued).toBeGreaterThan(before);
    const mine = await listCoupons({ promotionId: promotion.id, customerId: customer.customerId });
    expect(mine.items).toHaveLength(1);
  });
});

describe('實發券的歸屬', () => {
  it('只有擁有者用得了，別人拿到同一組碼也用不了', async () => {
    const promotion = await couponPromotion();
    const owner = await buyer('owner');
    const thief = await buyer('thief');
    await issue({ promotionId: promotion.id, customerIds: [owner.customerId] });
    const code = (await listCoupons({ customerId: owner.customerId })).items[0].code;

    const product = await sellable(`ISSUE-${randomUUID().slice(0, 6)}`);
    await addToCart(product.id, owner);
    await addToCart(product.id, thief);

    expect((await applyCoupon(code, owner)).discountCents).toBe(1_000);
    await expect(applyCoupon(code, thief)).rejects.toMatchObject({ details: { reason: 'not_eligible' } });
  });

  it('過期的實發券用不了', async () => {
    const promotion = await couponPromotion();
    const customer = await buyer('expiring');
    await issue({ promotionId: promotion.id, customerIds: [customer.customerId], expiresInDays: 1 });
    const coupon = (await listCoupons({ customerId: customer.customerId })).items[0];

    await h.runtime.database.db.execute(sql`
      UPDATE coupon_coupons SET ends_at = now() - interval '1 hour' WHERE id = ${coupon.id}
    `);

    const product = await sellable(`ISSUE-EXP-${randomUUID().slice(0, 6)}`);
    await addToCart(product.id, customer);
    await expect(applyCoupon(coupon.code, customer)).rejects.toMatchObject({ details: { reason: 'expired' } });
  });
});
