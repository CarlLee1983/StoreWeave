import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PlatformError } from '@storeweave/contracts';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 購物車結帳轉單（工單 28）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const addToCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', input, { actor, idempotencyKey: randomUUID() });

const getCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.cart.getCart', input, { actor });

const checkout = (actor: any, cartId: string, idempotencyKey = randomUUID()) =>
  h.runtime.commands.execute<any>('commerce.order.checkoutCart', { cartId }, { actor, idempotencyKey });

/** 結帳要帶購物車識別碼——它就是這次結帳的冪等鍵。 */
const cartIdOf = async (actor: any) => (await getCart({}, actor)).id;

async function sellable(sku: string, priceCents = 10_000, stock = 20) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, stock);
  return product;
}

const buyer = (tag: string) => createCustomer(h.runtime, { email: `checkout-${tag}-${randomUUID()}@example.test` });

describe('購物車結帳轉單', () => {
  it('一次買多件：所有商品行都進了同一張訂單，金額當場凍結', async () => {
    const customer = await buyer('multi');
    const a = await sellable(`CO-A-${randomUUID().slice(0, 6)}`, 3_000);
    const b = await sellable(`CO-B-${randomUUID().slice(0, 6)}`, 4_500);
    await addToCart({ productId: a.id, quantity: 2 }, customer);
    await addToCart({ productId: b.id, quantity: 1 }, customer);

    const order = await checkout(customer, await cartIdOf(customer));

    expect(order.lines).toHaveLength(2);
    expect(order.subtotalCents).toBe(10_500);
    expect(order.totalCents).toBe(10_500);
    expect(order.customerEmail).toBe(customer.email);

    // 凍結：訂單成立後改價，訂單金額不動。
    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: a.id, priceCents: 9_999 }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const reread = await h.runtime.queries.execute<any>('commerce.order.getOrder', { number: order.number }, { actor: customer });
    expect(reread.subtotalCents).toBe(10_500);
  });

  it('結帳成功後購物車被清空', async () => {
    const customer = await buyer('empty');
    const product = await sellable(`CO-CLEAR-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: product.id, quantity: 1 }, customer);

    await checkout(customer, await cartIdOf(customer));

    expect((await getCart({}, customer)).items).toEqual([]);
  });

  it('同一個購物車重複送出結帳只得到同一張訂單', async () => {
    const customer = await buyer('idem');
    const product = await sellable(`CO-IDEM-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: product.id, quantity: 1 }, customer);

    const cartId = await cartIdOf(customer);
    const first = await checkout(customer, cartId);
    // 不同的冪等鍵：擋下第二張訂單的必須是購物車本身，不是呼叫端記得帶對 key。
    const second = await checkout(customer, cartId, randomUUID());

    expect(second.id).toBe(first.id);
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${customer.customerId}
    `);
    expect(rows.rows[0].count).toBe('1');
  });

  it('併發送出結帳也只會產生一張訂單', async () => {
    const customer = await buyer('race');
    const product = await sellable(`CO-RACE-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: product.id, quantity: 1 }, customer);

    const cartId = await cartIdOf(customer);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => checkout(customer, cartId, randomUUID())),
    );

    // 四筆都要成功而且指向同一張單：允許失敗會讓這條測試在「全部炸掉」時也綠。
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${customer.customerId}
    `);
    expect(rows.rows[0].count).toBe('1');
  });

  it('庫存不足時整筆失敗，訊息指得出是哪一件商品', async () => {
    const customer = await buyer('stock');
    const plenty = await sellable(`CO-OK-${randomUUID().slice(0, 6)}`, 1_000, 50);
    const scarce = await sellable(`CO-LOW-${randomUUID().slice(0, 6)}`, 1_000, 1);
    await addToCart({ productId: plenty.id, quantity: 1 }, customer);
    await addToCart({ productId: scarce.id, quantity: 5 }, customer);

    await expect(checkout(customer, await cartIdOf(customer))).rejects.toThrow(new RegExp(scarce.sku));

    // 失敗是整筆失敗：沒有半張訂單，車也還在。
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${customer.customerId}
    `);
    expect(rows.rows[0].count).toBe('0');
    expect((await getCart({}, customer)).items).toHaveLength(2);
  });

  it('空的購物車結不了帳', async () => {
    const customer = await buyer('void');
    await expect(checkout(customer, await cartIdOf(customer))).rejects.toThrow(PlatformError);
  });

  it('未登入結不了帳：那張單沒有歸屬', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`CO-ANON-${randomUUID().slice(0, 6)}`);
    await addToCart({ guestToken, productId: product.id, quantity: 1 });

    const guestCartId = (await getCart({ guestToken })).id;
    await expect(checkout(STOREFRONT_ACTOR, guestCartId)).rejects.toThrow(PlatformError);

    // 訪客那台車也不是別的會員結得了的。
    const someone = await buyer('thief');
    await expect(checkout(someone, guestCartId)).rejects.toThrow(PlatformError);
  });

  it('下架的商品不會被結進訂單——顧客本來就看不到它', async () => {
    const customer = await buyer('archived');
    const alive = await sellable(`CO-ALIVE-${randomUUID().slice(0, 6)}`);
    const gone = await sellable(`CO-GONE-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: alive.id, quantity: 1 }, customer);
    await addToCart({ productId: gone.id, quantity: 1 }, customer);
    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: gone.id, status: 'archived' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const order = await checkout(customer, await cartIdOf(customer));

    expect(order.lines.map((l: any) => l.productId)).toEqual([alive.id]);
  });
});
