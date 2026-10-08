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

async function item(stock = 3) {
  const created = await createProduct(h.runtime);
  await stockUp(h.runtime, created.id, stock);
  return created;
}

async function cartFor(customer: Customer, lines: { productId: string; quantity: number }[]) {
  for (const line of lines) {
    await h.runtime.commands.execute('commerce.cart.addToCart', line,
      { actor: customer, idempotencyKey: randomUUID() });
  }
  return (await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer })).id;
}

const inputFor = (_customer: Customer, cartId: string) => checkoutInput(h, cartId);

const checkout = (customer: Customer, input: Awaited<ReturnType<typeof inputFor>>, key = randomUUID()) =>
  h.runtime.commands.execute<any>('commerce.order.checkoutCart', input, { actor: customer, idempotencyKey: key });

async function countOrders(customer: Customer) {
  const result = await h.runtime.database.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${customer.customerId}
  `);
  return Number(result.rows[0]!.count);
}

const stockOf = (productId: string) => h.runtime.queries.execute<any>(
  'commerce.inventory.getStock', { productId }, { actor: ADMIN_ACTOR },
);

describe('numbered checkout replay conformance', () => {
  it('ORD-01 establishes a pending order with identity, total including shipping, and payment deadline', async () => {
    const customer = await createCustomer(h.runtime);
    const product = await item();
    const cartId = await cartFor(customer, [{ productId: product.id, quantity: 2 }]);
    const order = await checkout(customer, await inputFor(customer, cartId));

    expect(order.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(order.number).toBeTruthy();
    expect(order.status).toBe('pending');
    expect(order.subtotalCents).toBe(2_000);
    expect(order.shippingCents).toBe(100);
    expect(order.totalCents).toBe(2_100);
    expect(new Date(order.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await stockOf(product.id)).toMatchObject({ onHand: 3, reserved: 2, available: 1 });
  });

  it('ORD-11 replays concurrent identical keys to one order and one reservation', async () => {
    const customer = await createCustomer(h.runtime);
    const product = await item();
    const cartId = await cartFor(customer, [{ productId: product.id, quantity: 1 }]);
    const input = await inputFor(customer, cartId);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => checkout(customer, input, key)));

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await countOrders(customer)).toBe(1);
    expect(await stockOf(product.id)).toMatchObject({ onHand: 3, reserved: 1, available: 2 });
  });

  it('ORD-13 rejects a reused key with another cart or changed recipient', async () => {
    const customer = await createCustomer(h.runtime);
    const first = await item();
    const second = await item();
    const firstCart = await cartFor(customer, [{ productId: first.id, quantity: 1 }]);
    const originalInput = await inputFor(customer, firstCart);
    const key = randomUUID();
    const original = await checkout(customer, originalInput, key);
    const nextCart = await cartFor(customer, [{ productId: second.id, quantity: 1 }]);

    await expect(checkout(customer, await inputFor(customer, nextCart), key)).rejects
      .toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    await expect(checkout(customer, {
      ...originalInput,
      destination: { ...originalInput.destination!, recipient: 'Different recipient' },
    }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    expect(await countOrders(customer)).toBe(1);
    expect(await stockOf(first.id)).toMatchObject({ reserved: 1 });
    expect(await stockOf(second.id)).toMatchObject({ reserved: 0 });
    expect((await h.runtime.queries.execute<any>('commerce.order.getOrder', { id: original.id }, { actor: customer })).id)
      .toBe(original.id);
  });

  it('ORD-14 treats reordered confirmed prices and destination edge whitespace as the same replay', async () => {
    const customer = await createCustomer(h.runtime);
    const first = await item();
    const second = await item();
    const cartId = await cartFor(customer, [
      { productId: first.id, quantity: 1 }, { productId: second.id, quantity: 1 },
    ]);
    const input = await inputFor(customer, cartId);
    await expect(checkout(customer, {
      ...input,
      destination: { ...input.destination, recipient: '   ' },
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const key = randomUUID();
    const original = await checkout(customer, {
      ...input,
      destination: {
        ...input.destination,
        recipient: `  ${input.destination.recipient}  `,
        phone: `  ${input.destination.phone}  `,
        postcode: `  ${input.destination.postcode}  `,
        line1: `  ${input.destination.line1}  `,
      },
    }, key);
    const stored = await h.runtime.queries.execute<any>('commerce.order.getOrder', { id: original.id }, { actor: customer });
    expect(stored.delivery.destination).toMatchObject({
      recipient: input.destination.recipient,
      phone: input.destination.phone,
      postcode: input.destination.postcode,
      line1: input.destination.line1,
    });
    const replay = await checkout(customer, {
      ...input,
      confirmedPrices: [...input.confirmedPrices].reverse(),
    }, key);

    expect(replay.id).toBe(original.id);
    expect(await countOrders(customer)).toBe(1);
    expect(await stockOf(first.id)).toMatchObject({ reserved: 1 });
    expect(await stockOf(second.id)).toMatchObject({ reserved: 1 });
  });

  it('ORD-19 returns the original order for the same cart with a new key and changed recipient', async () => {
    const customer = await createCustomer(h.runtime);
    const product = await item();
    const cartId = await cartFor(customer, [{ productId: product.id, quantity: 1 }]);
    const input = await inputFor(customer, cartId);
    const original = await checkout(customer, input);
    const replay = await checkout(customer, {
      ...input,
      destination: { ...input.destination!, recipient: 'Another recipient' },
    }, randomUUID());

    expect(replay.id).toBe(original.id);
    expect(await countOrders(customer)).toBe(1);
    expect(await stockOf(product.id)).toMatchObject({ onHand: 3, reserved: 1, available: 2 });
  });
});
