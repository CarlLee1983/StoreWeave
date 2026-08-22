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
    await expect(getOrder({ id: order.id }, bob)).rejects.toThrow(/not found/i);

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

describe('寫入路徑也依身分限縮', () => {
  const cancel = (orderId: string, actor: any) =>
    h.runtime.commands.execute('commerce.order.cancelOrder', { orderId, reason: 'x' },
      { actor, idempotencyKey: randomUUID() });

  const pay = (orderId: string, actor: any) =>
    h.runtime.commands.execute('commerce.order.payOrder', { orderId },
      { actor, idempotencyKey: randomUUID() });

  async function orderOf(actor: any, sku: string) {
    const product = await createProduct(h.runtime, { sku });
    await stockUp(h.runtime, product.id, 5);
    return placeOrder(h.runtime, product.id, 1, actor);
  }

  it('取消不了別人的訂單，而且回的是「找不到」', async () => {
    const alice = await createCustomer(h.runtime);
    const bob = await createCustomer(h.runtime);
    const order = await orderOf(alice, `WRITE-CANCEL-${randomUUID().slice(0, 6)}`);

    await expect(cancel(order.id, bob)).rejects.toThrow(/not found/i);

    const still = await getOrder({ id: order.id }, alice);
    expect(still.status).toBe('pending');
  });

  it('也付不了別人的訂單', async () => {
    const alice = await createCustomer(h.runtime);
    const bob = await createCustomer(h.runtime);
    const order = await orderOf(alice, `WRITE-PAY-${randomUUID().slice(0, 6)}`);

    await expect(pay(order.id, bob)).rejects.toThrow(/not found/i);
    expect((await getOrder({ id: order.id }, alice)).status).toBe('pending');
  });

  it('自己的訂單當然取消得了，後台也不受影響', async () => {
    const alice = await createCustomer(h.runtime);
    const mine = await orderOf(alice, `WRITE-OWN-${randomUUID().slice(0, 6)}`);
    await cancel(mine.id, alice);
    expect((await getOrder({ id: mine.id }, alice)).status).toBe('cancelled');

    const other = await orderOf(alice, `WRITE-ADMIN-${randomUUID().slice(0, 6)}`);
    await cancel(other.id, ADMIN_ACTOR);
    expect((await getOrder({ id: other.id })).status).toBe('cancelled');
  });

  it('被停用的顧客什麼都做不了', async () => {
    const customer = await createCustomer(h.runtime);
    const order = await orderOf(customer, `WRITE-DISABLED-${randomUUID().slice(0, 6)}`);

    await h.runtime.commands.execute('commerce.customer.setCustomerStatus',
      { customerId: customer.customerId, status: 'disabled' }, { actor: ADMIN_ACTOR });

    await expect(getOrder({ id: order.id }, customer)).rejects.toThrow(/disabled/i);
    await expect(cancel(order.id, customer)).rejects.toThrow(/disabled/i);
  });

  it('舊客戶端繼續送 customerEmail 會被擋下來，而不是被靜默忽略', async () => {
    const customer = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { sku: `WRITE-STRICT-${randomUUID().slice(0, 6)}` });
    await stockUp(h.runtime, product.id, 2);

    await expect(h.runtime.commands.execute('commerce.order.placeOrder',
      { customerEmail: 'someone-else@example.com', lines: [{ productId: product.id, quantity: 1 }] },
      { actor: customer, idempotencyKey: randomUUID() },
    )).rejects.toThrow(PlatformError);
  });

  it('訂單上的 email 來自帳號，不是呼叫端說了算', async () => {
    const customer = await createCustomer(h.runtime, { email: 'truth@example.com' });
    const order = await orderOf(customer, `WRITE-EMAIL-${randomUUID().slice(0, 6)}`);

    expect(order.customerEmail).toBe('truth@example.com');
    expect(order.customerId).toBe(customer.customerId);
  });
});
