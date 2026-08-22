import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformError } from '@storeweave/contracts';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

/** 登入時合併購物車（工單 27）。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const addToCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.commands.execute<any>('commerce.cart.addToCart', input, { actor, idempotencyKey: randomUUID() });

const getCart = (input: Record<string, unknown>, actor: any = STOREFRONT_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.cart.getCart', input, { actor });

const merge = (guestToken: string, actor: any) =>
  h.runtime.commands.execute<any>('commerce.cart.mergeGuestCart', { guestToken }, { actor, idempotencyKey: randomUUID() });

async function sellable(sku: string, priceCents = 10_000) {
  const product = await createProduct(h.runtime, { sku, name: sku, priceCents });
  await stockUp(h.runtime, product.id, 20);
  return product;
}

const quantityOf = (cart: any, productId: string) =>
  cart.items.find((i: any) => i.productId === productId)?.quantity ?? null;

describe('登入時合併購物車', () => {
  it('訪客購物車併入該顧客的購物車，兩邊的商品都在', async () => {
    const guestToken = randomUUID();
    const customer = await createCustomer(h.runtime, { email: `merge-a-${randomUUID()}@example.test` });
    const guestOnly = await sellable(`MERGE-G-${randomUUID().slice(0, 6)}`);
    const memberOnly = await sellable(`MERGE-M-${randomUUID().slice(0, 6)}`);

    await addToCart({ guestToken, productId: guestOnly.id, quantity: 2 });
    await addToCart({ productId: memberOnly.id, quantity: 1 }, customer);

    const merged = await merge(guestToken, customer);

    expect(quantityOf(merged, guestOnly.id)).toBe(2);
    expect(quantityOf(merged, memberOnly.id)).toBe(1);
    expect(merged.removedNames).toEqual([]);
  });

  it('同一件商品兩邊都有時取較大數量，不是相加', async () => {
    const guestToken = randomUUID();
    const customer = await createCustomer(h.runtime, { email: `merge-b-${randomUUID()}@example.test` });
    const product = await sellable(`MERGE-MAX-${randomUUID().slice(0, 6)}`);

    await addToCart({ guestToken, productId: product.id, quantity: 3 });
    await addToCart({ productId: product.id, quantity: 1 }, customer);

    expect(quantityOf(await merge(guestToken, customer), product.id)).toBe(3);
  });

  it('會員那邊比較多時，合併不會把數量改小', async () => {
    const guestToken = randomUUID();
    const customer = await createCustomer(h.runtime, { email: `merge-c-${randomUUID()}@example.test` });
    const product = await sellable(`MERGE-KEEP-${randomUUID().slice(0, 6)}`);

    await addToCart({ guestToken, productId: product.id, quantity: 1 });
    await addToCart({ productId: product.id, quantity: 4 }, customer);

    expect(quantityOf(await merge(guestToken, customer), product.id)).toBe(4);
  });

  it('已下架的商品在合併時移除，並且說得出是哪一件', async () => {
    const guestToken = randomUUID();
    const customer = await createCustomer(h.runtime, { email: `merge-d-${randomUUID()}@example.test` });
    const product = await sellable(`MERGE-GONE-${randomUUID().slice(0, 6)}`);
    await addToCart({ guestToken, productId: product.id, quantity: 2 });

    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: product.id, status: 'archived' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const merged = await merge(guestToken, customer);

    expect(merged.items).toEqual([]);
    expect(merged.removedNames).toEqual([product.sku]);
  });

  it('合併後訪客購物車不再有效：同一張 token 拿到的是空車', async () => {
    const guestToken = randomUUID();
    const customer = await createCustomer(h.runtime, { email: `merge-e-${randomUUID()}@example.test` });
    const product = await sellable(`MERGE-DEAD-${randomUUID().slice(0, 6)}`);
    await addToCart({ guestToken, productId: product.id, quantity: 2 });

    await merge(guestToken, customer);

    expect((await getCart({ guestToken })).items).toEqual([]);
    // 再合併一次不會把已經進去的東西再算一次。
    const again = await merge(guestToken, customer);
    expect(quantityOf(again, product.id)).toBe(2);
  });

  it('訪客那台車不存在時，合併是無事發生，不是錯誤', async () => {
    const customer = await createCustomer(h.runtime, { email: `merge-f-${randomUUID()}@example.test` });
    const product = await sellable(`MERGE-NONE-${randomUUID().slice(0, 6)}`);
    await addToCart({ productId: product.id, quantity: 1 }, customer);

    const merged = await merge(randomUUID(), customer);
    expect(quantityOf(merged, product.id)).toBe(1);
    expect(merged.removedNames).toEqual([]);
  });

  it('沒有顧客身分的人合併不了：那個動作沒有目的地', async () => {
    const guestToken = randomUUID();
    const product = await sellable(`MERGE-ANON-${randomUUID().slice(0, 6)}`);
    await addToCart({ guestToken, productId: product.id, quantity: 1 });

    await expect(merge(guestToken, STOREFRONT_ACTOR)).rejects.toThrow(PlatformError);
  });
});
