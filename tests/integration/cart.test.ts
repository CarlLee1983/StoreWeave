import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PlatformError } from '@storeweave/contracts';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 購物車與訪客識別（工單 25）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

type Actor = Parameters<typeof getCart>[1];

const addToCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', input, { actor, idempotencyKey: randomUUID() });

const setQuantity = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.setCartItemQuantity', input, { actor, idempotencyKey: randomUUID() });

const removeItem = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.removeCartItem', input, { actor, idempotencyKey: randomUUID() });

const clearCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.clearCart', input, { actor, idempotencyKey: randomUUID() });

const getCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.cart.getCart', input, { actor });

async function sellable(sku: string, priceCents = 10_000) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, 20);
  return product;
}

describe('訪客的購物車', () => {
  it('以 token 綁定，跨請求持續存在', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`CART-GUEST-${randomUUID().slice(0, 6)}`);

    await addToCart({ guestToken, productId: product.id, quantity: 2 });
    const cart = await getCart({ guestToken });

    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({ productId: product.id, quantity: 2, sku: product.sku });
  });

  it('不同的 token 是不同的購物車', async () => {
    const mine = randomUUID();
    const yours = randomUUID();
    const product = await sellable(`CART-SPLIT-${randomUUID().slice(0, 6)}`);

    await addToCart({ guestToken: mine, productId: product.id, quantity: 1 });

    expect((await getCart({ guestToken: yours })).items).toEqual([]);
  });

  it('沒有 token 也沒有身分時，購物車操作被明確拒絕', async () => {
    const product = await sellable(`CART-NOID-${randomUUID().slice(0, 6)}`);
    await expect(addToCart({ productId: product.id, quantity: 1 })).rejects.toThrow(PlatformError);
  });
});

describe('會員的購物車', () => {
  it('以顧客識別綁定，一個顧客最多一個有效購物車', async () => {
    const customer = await createCustomer(h.runtime);
    const a = await sellable(`CART-MEMBER-A-${randomUUID().slice(0, 6)}`);
    const b = await sellable(`CART-MEMBER-B-${randomUUID().slice(0, 6)}`);

    await addToCart({ productId: a.id, quantity: 1 }, customer);
    await addToCart({ productId: b.id, quantity: 3 }, customer);

    const cart = await getCart({}, customer);
    expect(cart.items).toHaveLength(2);

    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM cart_carts WHERE customer_id = ${customer.customerId} AND status = 'open'
    `);
    expect(rows.rows[0].count).toBe('1');
  });

  it('會員身分帶著 guestToken 時，以會員的購物車為準', async () => {
    const customer = await createCustomer(h.runtime);
    const guestToken = randomUUID();
    const product = await sellable(`CART-IGNORE-${randomUUID().slice(0, 6)}`);

    await addToCart({ guestToken, productId: product.id, quantity: 1 }, customer);

    expect((await getCart({}, customer)).items).toHaveLength(1);
    expect((await getCart({ guestToken })).items).toEqual([]);
  });
});

describe('加入、調整、移除、清空', () => {
  it('重複加入同一件商品是累加數量，不是多一行', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`CART-ADD-${randomUUID().slice(0, 6)}`);

    await addToCart({ guestToken, productId: product.id, quantity: 1 });
    const cart = await addToCart({ guestToken, productId: product.id, quantity: 2 });

    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(3);
  });

  it('調整數量會覆寫而不是累加，設成 0 等於移除', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`CART-QTY-${randomUUID().slice(0, 6)}`);
    await addToCart({ guestToken, productId: product.id, quantity: 5 });

    const updated = await setQuantity({ guestToken, productId: product.id, quantity: 2 });
    expect(updated.items[0].quantity).toBe(2);

    const emptied = await setQuantity({ guestToken, productId: product.id, quantity: 0 });
    expect(emptied.items).toEqual([]);
  });

  it('移除與清空', async () => {
    const guestToken = randomUUID();
    const a = await sellable(`CART-RM-A-${randomUUID().slice(0, 6)}`);
    const b = await sellable(`CART-RM-B-${randomUUID().slice(0, 6)}`);
    await addToCart({ guestToken, productId: a.id, quantity: 1 });
    await addToCart({ guestToken, productId: b.id, quantity: 1 });

    const removed = await removeItem({ guestToken, productId: a.id });
    expect(removed.items.map((i: any) => i.productId)).toEqual([b.id]);

    const cleared = await clearCart({ guestToken });
    expect(cleared.items).toEqual([]);
  });

  it('下架的商品加不進購物車', async () => {
    const guestToken = randomUUID();
    const draft = await createProduct(h.runtime, { sku: `CART-DRAFT-${randomUUID().slice(0, 6)}`, status: 'draft' });

    await expect(addToCart({ guestToken, productId: draft.id, quantity: 1 })).rejects.toThrow();
  });

  it('購物車顯示的是當下的價格，不凍結', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`CART-PRICE-${randomUUID().slice(0, 6)}`, 10_000);
    await addToCart({ guestToken, productId: product.id, quantity: 2 });

    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: product.id, priceCents: 12_000 }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const cart = await getCart({ guestToken });
    expect(cart.items[0].unitPriceCents).toBe(12_000);
    expect(cart.subtotalCents).toBe(24_000);
  });
});

describe('購物車不預留庫存', () => {
  it('加入購物車不改變任何庫存數字', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`CART-STOCK-${randomUUID().slice(0, 6)}`);
    const before = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });

    await addToCart({ guestToken, productId: product.id, quantity: 5 });

    const after = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(after).toEqual(before);
  });

  it('數量可以超過現有庫存——買不買得到在結帳當下才決定', async () => {
    const guestToken = randomUUID();
    const product = await createProduct(h.runtime, { sku: `CART-OVER-${randomUUID().slice(0, 6)}`, name: '缺貨' });
    await stockUp(h.runtime, product.id, 1);

    const cart = await addToCart({ guestToken, productId: product.id, quantity: 9 });
    expect(cart.items[0].quantity).toBe(9);
  });
});
