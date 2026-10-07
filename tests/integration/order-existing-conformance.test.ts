import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_ACTOR, checkoutInput, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

const buyer = () => createCustomer(h.runtime);

async function product(stock: number, name = 'Original name', priceCents = 1_000) {
  const created = await createProduct(h.runtime, { name, priceCents });
  await stockUp(h.runtime, created.id, stock);
  return created;
}

async function cartWith(actor: Awaited<ReturnType<typeof buyer>>, lines: { productId: string; quantity: number }[]) {
  for (const line of lines) {
    await h.runtime.commands.execute('commerce.cart.addToCart', line, { actor, idempotencyKey: randomUUID() });
  }
  const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor });
  return cart.id;
}

const checkout = async (actor: Awaited<ReturnType<typeof buyer>>, cartId: string, key = randomUUID()) =>
  h.runtime.commands.execute<any>('commerce.order.checkoutCart', await checkoutInput(h, cartId), { actor, idempotencyKey: key });

const stockOf = (productId: string) =>
  h.runtime.queries.execute<{ onHand: number; reserved: number; available: number }>(
    'commerce.inventory.getStock', { productId }, { actor: ADMIN_ACTOR },
  );

async function orderCount(customerId: string) {
  const result = await h.runtime.database.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${customerId}
  `);
  return Number(result.rows[0]!.count);
}

describe('existing order conformance', () => {
  it('ORD-02 keeps the line name, unit price, and total after catalog changes', async () => {
    const customer = await buyer();
    const item = await product(2);
    const order = await checkout(customer, await cartWith(customer, [{ productId: item.id, quantity: 1 }]));
    await h.runtime.commands.execute('commerce.catalog.updateProduct',
      { id: item.id, name: 'Renamed product', priceCents: 9_000 },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const saved = await h.runtime.queries.execute<any>('commerce.order.getOrder', { id: order.id }, { actor: customer });
    expect(saved.lines[0]).toMatchObject({ productId: item.id, name: 'Original name', unitPriceCents: 1_000 });
    expect(saved.totalCents).toBe(order.totalCents);
    expect(saved.totalCents).toBe(1_100);
  });

  it('ORD-06 rejects all lines atomically when one line has insufficient stock', async () => {
    const customer = await buyer();
    const enough = await product(3);
    const scarce = await product(1);
    const cartId = await cartWith(customer, [
      { productId: enough.id, quantity: 2 }, { productId: scarce.id, quantity: 2 },
    ]);

    await expect(checkout(customer, cartId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await orderCount(customer.customerId)).toBe(0);
    expect(await stockOf(enough.id)).toMatchObject({ onHand: 3, reserved: 0, available: 3 });
    expect(await stockOf(scarce.id)).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
  });

  it('ORD-07 refuses the next buyer after all available stock is reserved', async () => {
    const item = await product(2);
    const first = await buyer();
    const second = await buyer();
    const firstOrder = await checkout(first, await cartWith(first, [{ productId: item.id, quantity: 2 }]));
    expect(firstOrder.status).toBe('pending');
    expect(await stockOf(item.id)).toMatchObject({ onHand: 2, reserved: 2, available: 0 });

    await expect(checkout(second, await cartWith(second, [{ productId: item.id, quantity: 1 }]))).rejects
      .toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await orderCount(second.customerId)).toBe(0);
    expect(await stockOf(item.id)).toMatchObject({ onHand: 2, reserved: 2, available: 0 });
  });

  it('ORD-08 lets exactly one of two concurrent buyers reserve the last item', async () => {
    const item = await product(1);
    const customers = await Promise.all([buyer(), buyer()]);
    const carts = await Promise.all(customers.map((customer) =>
      cartWith(customer, [{ productId: item.id, quantity: 1 }])));

    const results = await Promise.allSettled(customers.map((customer, index) => checkout(customer, carts[index]!)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code))
      .toEqual(['VALIDATION_ERROR']);
    expect((await Promise.all(customers.map((customer) => orderCount(customer.customerId)))).reduce((a, b) => a + b, 0)).toBe(1);
    expect(await stockOf(item.id)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
  });

  it('ORD-09 bounds concurrent multi-line orders and leaves no loser orders or reservations', async () => {
    const firstItem = await product(2);
    const secondItem = await product(2);
    const customers = await Promise.all(Array.from({ length: 3 }, () => buyer()));
    const carts = await Promise.all(customers.map((customer) => cartWith(customer, [
      { productId: firstItem.id, quantity: 1 }, { productId: secondItem.id, quantity: 1 },
    ])));

    const results = await Promise.allSettled(customers.map((customer, index) => checkout(customer, carts[index]!)));
    const winners = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled');
    expect(winners).toHaveLength(2);
    expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code))
      .toEqual(['VALIDATION_ERROR']);
    const counts = await Promise.all(customers.map((customer) => orderCount(customer.customerId)));
    expect(counts).toEqual(results.map((result) => result.status === 'fulfilled' ? 1 : 0));
    for (const item of [firstItem, secondItem]) {
      const reserved = winners.reduce((total, result) => total +
        result.value.lines.filter((line: { productId: string }) => line.productId === item.id)
          .reduce((sum: number, line: { quantity: number }) => sum + line.quantity, 0), 0);
      expect(reserved).toBe(2);
      expect(await stockOf(item.id)).toMatchObject({ onHand: 2, reserved, available: 2 - reserved });
    }
  });

  it('ORD-10 replays the original order after another buyer consumes the remaining stock', async () => {
    const item = await product(2);
    const first = await buyer();
    const second = await buyer();
    const cartId = await cartWith(first, [{ productId: item.id, quantity: 1 }]);
    const key = randomUUID();
    const original = await checkout(first, cartId, key);
    await checkout(second, await cartWith(second, [{ productId: item.id, quantity: 1 }]));
    expect(await stockOf(item.id)).toMatchObject({ onHand: 2, reserved: 2, available: 0 });

    const replay = await checkout(first, cartId, key);
    expect(replay.id).toBe(original.id);
    expect(await orderCount(first.customerId)).toBe(1);
    expect(await stockOf(item.id)).toMatchObject({ onHand: 2, reserved: 2, available: 0 });
  });
});
