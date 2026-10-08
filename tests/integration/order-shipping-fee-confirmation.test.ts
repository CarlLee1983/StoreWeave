import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { shippingService } from '@storeweave/shipping';
import {
  ADMIN_ACTOR, checkoutInput, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

async function awaitLockedRead(locked: Promise<void>, checkout: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      locked,
      checkout.then(() => { throw new Error('Checkout completed before its shipping lock was observed'); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for checkout shipping lock')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForMerchantUpdateBlocked(table: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const activity = await h.runtime.database.pool.query<{ waiting: number }>(`
      SELECT count(*)::integer AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND cardinality(pg_blocking_pids(pid)) > 0 AND query ILIKE '%${table}%'
    `);
    if (activity.rows[0]!.waiting > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected merchant update of ${table} to wait on checkout lock`);
}

describe('Order shipping fee confirmation', () => {
  it('ORD-16 holds the confirmed shipping fee until the Order snapshot commits', async () => {
    const buyer = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { priceCents: 1_000 });
    await stockUp(h.runtime, product.id, 2);
    const method = await h.runtime.commands.execute<{ id: string }>('commerce.shipping.createShippingMethod', {
      code: `lock-fee-${randomUUID().slice(0, 8)}`, name: 'Locked fee method',
      provider: 'manual', type: 'home_delivery', destinationKind: 'taiwan_home', feeCents: 100,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
      { actor: buyer, idempotencyKey: randomUUID() });
    const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: buyer });
    const input = { ...await checkoutInput(h, cart.id), shippingMethodId: method.id };

    let reached!: () => void;
    const locked = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const original = shippingService.resolveCheckoutMethodForOrder;
    let paused = false;
    const spy = vi.spyOn(shippingService, 'resolveCheckoutMethodForOrder').mockImplementation(async (tx, request) => {
      const result = await original(tx, request);
      if (request.shippingMethodId === method.id && !paused) {
        paused = true;
        reached();
        await hold;
      }
      return result;
    });
    const checkout = h.runtime.commands.execute<any>('commerce.order.checkoutCart', input,
      { actor: buyer, idempotencyKey: randomUUID() });
    let update: Promise<unknown> | undefined;
    try {
      await awaitLockedRead(locked, checkout);
      update = h.runtime.commands.execute('commerce.shipping.updateShippingMethod',
        { id: method.id, feeCents: 250 },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
      await waitForMerchantUpdateBlocked('shipping_methods');
      const before = await h.runtime.database.db.execute<{ fee: number }>(sql`
        SELECT fee_cents AS fee FROM shipping_methods WHERE id = ${method.id}
      `);
      expect(before.rows[0]!.fee).toBe(100);
    } finally {
      release();
      await Promise.allSettled([checkout, ...(update ? [update] : [])]);
      spy.mockRestore();
    }
    const order = await checkout;
    await update;
    const stored = await h.runtime.queries.execute<any>('commerce.order.getOrder', { id: order.id }, { actor: buyer });
    expect(stored).toMatchObject({ subtotalCents: 1_000, shippingCents: 100, totalCents: 1_100 });
    expect(stored.delivery).toMatchObject({ shippingMethodId: method.id });
    const after = await h.runtime.database.db.execute<{ fee: number }>(sql`
      SELECT fee_cents AS fee FROM shipping_methods WHERE id = ${method.id}
    `);
    expect(after.rows[0]!.fee).toBe(250);
  });

  it('ORD-17 rejects a changed fee, then replays one Order after a later fee change', async () => {
    const buyer = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { priceCents: 1_000 });
    await stockUp(h.runtime, product.id, 5);
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
      { actor: buyer, idempotencyKey: randomUUID() });
    const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: buyer });
    const input = await checkoutInput(h, cart.id);
    await h.runtime.commands.execute('commerce.shipping.updateShippingMethod', {
      id: h.defaultShippingMethodId, feeCents: 250,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const key = randomUUID();
    await expect(h.runtime.commands.execute('commerce.order.checkoutCart', input, { actor: buyer, idempotencyKey: key }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { kind: 'shipping_fee_changed', currentShippingCents: 250 } });
    const count = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${buyer.customerId}
    `);
    expect(count.rows[0].count).toBe('0');
    const stock = await h.runtime.queries.execute<{ reserved: number }>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(stock.reserved).toBe(0);

    const confirmed = { ...input, confirmedShippingCents: 250 };
    const order = await h.runtime.commands.execute<{ id: string; shippingCents: number }>(
      'commerce.order.checkoutCart', confirmed, { actor: buyer, idempotencyKey: key },
    );
    expect(order.shippingCents).toBe(250);

    await h.runtime.commands.execute('commerce.shipping.updateShippingMethod', {
      id: h.defaultShippingMethodId, feeCents: 300,
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const replay = await h.runtime.commands.execute<{ id: string; shippingCents: number }>(
      'commerce.order.checkoutCart', { ...confirmed, confirmedShippingCents: 300 }, { actor: buyer, idempotencyKey: key },
    );
    expect(replay.id).toBe(order.id);
    expect(replay.shippingCents).toBe(250);
    const finalCount = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${buyer.customerId}
    `);
    expect(finalCount.rows[0].count).toBe('1');
    const finalStock = await h.runtime.queries.execute<{ reserved: number }>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(finalStock.reserved).toBe(1);
  });
});
