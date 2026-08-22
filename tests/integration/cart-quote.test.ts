import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 購物車即時試算（工單 26）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

/** 活動是這個檔案的全域狀態，每個測試結束一律停用。 */
const created: string[] = [];

const createPromotion = async (input: Record<string, unknown>) => {
  const promotion = await h.runtime.commands.execute<any>('commerce.promotion.createPromotion', input, { actor: ADMIN_ACTOR });
  created.push(promotion.id);
  return promotion;
};

afterEach(async () => {
  for (const id of created.splice(0)) {
    await h.runtime.commands.execute('commerce.promotion.setPromotionStatus',
      { id, status: 'disabled' }, { actor: ADMIN_ACTOR });
  }
});

const addToCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', input, { actor, idempotencyKey: randomUUID() });

const getCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.cart.getCart', input, { actor });

const placeOrderLines = async (lines: { productId: string; quantity: number }[], actor: any) =>
  h.runtime.commands.execute<any>('commerce.order.placeOrder', { lines }, { actor, idempotencyKey: randomUUID() });

async function sellable(sku: string, priceCents: number) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, 50);
  return product;
}

describe('購物車即時試算', () => {
  it('回傳商品小計、折扣明細與預估總額', async () => {
    const promotion = await createPromotion({
      name: '購物車滿千折百',
      rule: { type: 'threshold_fixed_amount', thresholdCents: 100_000, discountCents: 10_000 },
    });
    const guestToken = randomUUID();
    const product = await sellable(`CARTQ-SUM-${randomUUID().slice(0, 6)}`, 60_000);

    await addToCart({ guestToken, productId: product.id, quantity: 2 });
    const cart = await getCart({ guestToken });

    expect(cart.subtotalCents).toBe(120_000);
    expect(cart.discountCents).toBe(10_000);
    expect(cart.totalCents).toBe(110_000);
    expect(cart.adjustments).toEqual([
      { source: 'promotion', sourceId: promotion.id, name: '購物車滿千折百', amountCents: -10_000 },
    ]);
    expect(cart.items[0]).toMatchObject({ discountCents: 10_000, netCents: 110_000 });
  });

  it('空車的試算是全零，而且不需要有購物車就答得出來', async () => {
    const cart = await getCart({ guestToken: randomUUID() });
    expect(cart).toMatchObject({ items: [], subtotalCents: 0, discountCents: 0, totalCents: 0, adjustments: [] });
  });

  it('商品漲價後購物車顯示的是最新價格，不是加入當下的價格', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`CARTQ-PRICE-${randomUUID().slice(0, 6)}`, 10_000);
    await addToCart({ guestToken, productId: product.id, quantity: 3 });

    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: product.id, priceCents: 12_000 }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const cart = await getCart({ guestToken });
    expect(cart.items[0].unitPriceCents).toBe(12_000);
    expect(cart.subtotalCents).toBe(36_000);
    expect(cart.totalCents).toBe(36_000);
  });

  it('試算與結帳走同一個定價引擎：逐行金額與調整明細完全相同', async () => {
    await createPromotion({
      name: '購物車比對用九折',
      rule: { type: 'order_percentage', percentOffBasisPoints: 1_000 },
    });
    // 除不盡的金額才踩得到餘數分攤那條路。
    const a = await sellable(`CARTQ-CMP-A-${randomUUID().slice(0, 6)}`, 3_333);
    const b = await sellable(`CARTQ-CMP-B-${randomUUID().slice(0, 6)}`, 1_111);
    const customer = await createCustomer(h.runtime, { email: `cartq-${randomUUID()}@example.test` });

    await addToCart({ productId: a.id, quantity: 3 }, customer);
    await addToCart({ productId: b.id, quantity: 2 }, customer);
    const cart = await getCart({}, customer);

    const placed = await placeOrderLines(
      [{ productId: a.id, quantity: 3 }, { productId: b.id, quantity: 2 }],
      customer,
    );

    expect(cart.subtotalCents).toBe(placed.subtotalCents);
    expect(cart.discountCents).toBe(placed.discountCents);
    expect(cart.totalCents).toBe(placed.totalCents);
    expect(cart.adjustments).toEqual(placed.adjustments);
    expect(cart.items.map((i: any) => [i.productId, i.quantity, i.lineTotalCents, i.discountCents, i.netCents]))
      .toEqual(placed.lines.map((l: any) =>
        [l.productId, l.quantity, l.lineTotalCents, l.discountCents, l.lineTotalCents - l.discountCents]));
  });

  it('試算不鎖定任何額度：可售量在試算前後相同', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`CARTQ-HOLD-${randomUUID().slice(0, 6)}`, 5_000);
    await addToCart({ guestToken, productId: product.id, quantity: 4 });

    const before = await getCart({ guestToken });
    await getCart({ guestToken });
    const after = await getCart({ guestToken });

    expect(before.items[0].available).toBe(50);
    expect(after.items[0].available).toBe(50);

    const rows = await h.runtime.database.db.execute<{ reserved: number }>(sql`
      SELECT reserved FROM inventory_stock WHERE product_id = ${product.id}
    `);
    expect(Number(rows.rows[0].reserved)).toBe(0);
  });
});
