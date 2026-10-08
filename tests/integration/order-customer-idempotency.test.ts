import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_ACTOR, checkoutInput, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

type Customer = Awaited<ReturnType<typeof createCustomer>>;

async function cartFor(customer: Customer, productId: string) {
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId, quantity: 1 },
    { actor: customer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  return cart.id;
}

const checkout = async (customer: Customer, cartId: string, key: string) =>
  h.runtime.commands.execute<any>('commerce.order.checkoutCart', await checkoutInput(h, cartId),
    { actor: customer, idempotencyKey: key });

async function orderCount(customer: Customer) {
  const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${customer.customerId}
  `);
  return Number(rows.rows[0]!.count);
}

describe('checkout customer idempotency', () => {
  it('ORD-12 lets two customers use the same raw key for their own carts and hides the foreign cart', async () => {
    const alice = await createCustomer(h.runtime);
    const bob = await createCustomer(h.runtime);
    const firstProduct = await createProduct(h.runtime, { name: 'Alice product', priceCents: 1_000 });
    const secondProduct = await createProduct(h.runtime, { name: 'Bob product', priceCents: 2_000 });
    await stockUp(h.runtime, firstProduct.id, 1);
    await stockUp(h.runtime, secondProduct.id, 1);
    const aliceCart = await cartFor(alice, firstProduct.id);
    const bobCart = await cartFor(bob, secondProduct.id);
    const key = randomUUID();

    const aliceOrder = await checkout(alice, aliceCart, key);
    // Reusing the same raw key must not return Alice's cached order or reveal her cart.
    const usedKeyError = await checkout(bob, aliceCart, key).catch((error: unknown) => error);
    const freshKeyError = await checkout(bob, aliceCart, randomUUID()).catch((error: unknown) => error);
    expect(usedKeyError).toMatchObject({ code: 'NOT_FOUND' });
    expect(freshKeyError).toMatchObject({ code: 'NOT_FOUND' });
    expect((usedKeyError as Error).message).toBe((freshKeyError as Error).message);
    const bobOrder = await checkout(bob, bobCart, key);
    expect(bobOrder.id).not.toBe(aliceOrder.id);
    expect(aliceOrder).toMatchObject({ customerEmail: alice.email, lines: [{ productId: firstProduct.id }] });
    expect(bobOrder).toMatchObject({ customerEmail: bob.email, lines: [{ productId: secondProduct.id }] });
    // Once Bob has used this key, a different payload mismatches Bob's own
    // record. It must never reveal or replay Alice's order.
    await expect(checkout(bob, aliceCart, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    expect(await orderCount(alice)).toBe(1);
    expect(await orderCount(bob)).toBe(1);

    const replay = await checkout(alice, aliceCart, key);
    expect(replay.id).toBe(aliceOrder.id);
    expect(await orderCount(alice)).toBe(1);
    const firstStock = await h.runtime.queries.execute<any>('commerce.inventory.getStock',
      { productId: firstProduct.id }, { actor: ADMIN_ACTOR });
    const secondStock = await h.runtime.queries.execute<any>('commerce.inventory.getStock',
      { productId: secondProduct.id }, { actor: ADMIN_ACTOR });
    expect(firstStock).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
    expect(secondStock).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
  });
});
