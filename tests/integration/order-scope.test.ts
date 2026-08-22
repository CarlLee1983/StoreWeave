import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformError } from '@storeweave/contracts';
import {
  ADMIN_ACTOR, STOREFRONT_ACTOR, createCustomer, createHarness, createProduct, placeOrder, stockUp, type TestHarness,
} from './helpers';

/** 訂單查詢依身分限縮（工單 12）：修掉「猜到訂單號就能讀別人的訂單」。 */

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const getOrder = (input: Record<string, unknown>, actor = ADMIN_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.order.getOrder', input, { actor });

const listOrders = (actor = ADMIN_ACTOR) =>
  h.runtime.queries.execute<any>('commerce.order.listOrders', {}, { actor });

describe('顧客只看得到自己的訂單', () => {
  it('以他人的訂單號查詢被拒，而且回的是「找不到」而不是「不准看」', async () => {
    const alice = await createCustomer(h.runtime);
    const bob = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { sku: `SCOPE-${randomUUID().slice(0, 6)}` });
    await stockUp(h.runtime, product.id, 5);
    const order = await placeOrder(h.runtime, product.id, 1, alice);

    await expect(getOrder({ number: order.number }, bob)).rejects.toThrow(/not found/i);
    await expect(getOrder({ id: order.id }, bob)).rejects.toThrow(PlatformError);

    const mine = await getOrder({ number: order.number }, alice);
    expect(mine.id).toBe(order.id);
  });

  it('清單只列出自己的訂單', async () => {
    const alice = await createCustomer(h.runtime);
    const bob = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { sku: `SCOPE-LIST-${randomUUID().slice(0, 6)}` });
    await stockUp(h.runtime, product.id, 5);
    const aliceOrder = await placeOrder(h.runtime, product.id, 1, alice);
    const bobOrder = await placeOrder(h.runtime, product.id, 1, bob);

    const aliceList = await listOrders(alice);
    expect(aliceList.items.map((o: any) => o.id)).toContain(aliceOrder.id);
    expect(aliceList.items.map((o: any) => o.id)).not.toContain(bobOrder.id);
  });

  it('匿名身分無法以訂單號取得任何訂單', async () => {
    const alice = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { sku: `SCOPE-ANON-${randomUUID().slice(0, 6)}` });
    await stockUp(h.runtime, product.id, 2);
    const order = await placeOrder(h.runtime, product.id, 1, alice);

    await expect(getOrder({ number: order.number }, STOREFRONT_ACTOR)).rejects.toThrow(/Forbidden|missing permission/i);
  });

  it('後台角色查詢訂單的行為不變', async () => {
    const alice = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { sku: `SCOPE-ADMIN-${randomUUID().slice(0, 6)}` });
    await stockUp(h.runtime, product.id, 2);
    const order = await placeOrder(h.runtime, product.id, 1, alice);

    const seen = await getOrder({ number: order.number });
    expect(seen.id).toBe(order.id);

    const all = await listOrders();
    expect(all.items.map((o: any) => o.id)).toContain(order.id);
  });
});
