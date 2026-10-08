import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { catalogService } from '@storeweave/catalog';
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
      checkout.then(() => { throw new Error('Checkout completed before its product lock was observed'); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for checkout product lock')), 5_000);
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

describe('Order price confirmation', () => {
  it('ORD-03 holds the confirmed product price until the Order snapshot commits', async () => {
    const buyer = await createCustomer(h.runtime);
    const product = await createProduct(h.runtime, { name: 'Locked price', priceCents: 1_000 });
    await stockUp(h.runtime, product.id, 2);
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
      { actor: buyer, idempotencyKey: randomUUID() });
    const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: buyer });
    const input = await checkoutInput(h, cart.id);

    let reached!: () => void;
    const locked = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const original = catalogService.findByIdForCheckout;
    let paused = false;
    const spy = vi.spyOn(catalogService, 'findByIdForCheckout').mockImplementation(async (tx, productId) => {
      const result = await original(tx, productId);
      if (productId === product.id && !paused) {
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
      update = h.runtime.commands.execute('commerce.catalog.updateProduct', { id: product.id, priceCents: 1_400 },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
      await waitForMerchantUpdateBlocked('catalog_products');
      const before = await h.runtime.database.db.execute<{ price: number }>(sql`
        SELECT price_cents AS price FROM catalog_products WHERE id = ${product.id}
      `);
      expect(before.rows[0]!.price).toBe(1_000);
    } finally {
      release();
      await Promise.allSettled([checkout, ...(update ? [update] : [])]);
      spy.mockRestore();
    }
    const order = await checkout;
    await update;
    const stored = await h.runtime.queries.execute<any>('commerce.order.getOrder', { id: order.id }, { actor: buyer });
    expect(stored.lines[0]).toMatchObject({ productId: product.id, unitPriceCents: 1_000 });
    expect(stored).toMatchObject({ subtotalCents: 1_000, shippingCents: 100, totalCents: 1_100 });
    const after = await h.runtime.database.db.execute<{ price: number }>(sql`
      SELECT price_cents AS price FROM catalog_products WHERE id = ${product.id}
    `);
    expect(after.rows[0]!.price).toBe(1_400);
  });

  it('ORD-15 rejects changed prices then accepts the same key after explicit reconfirmation', async () => {
    const buyer = await createCustomer(h.runtime);
    const rising = await createProduct(h.runtime, { name: '漲價商品', priceCents: 1_000 });
    const falling = await createProduct(h.runtime, { name: '降價商品', priceCents: 2_000 });
    const healthy = await createProduct(h.runtime, { name: '價格不變商品', priceCents: 3_000 });
    for (const product of [rising, falling, healthy]) {
      await stockUp(h.runtime, product.id, 5);
      await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 },
        { actor: buyer, idempotencyKey: randomUUID() });
    }
    const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: buyer });
    const original = await checkoutInput(h, cart.id);
    await h.runtime.commands.execute('commerce.catalog.updateProduct', { id: rising.id, priceCents: 1_200 },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await h.runtime.commands.execute('commerce.catalog.updateProduct', { id: falling.id, priceCents: 1_800 },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const key = randomUUID();
    await expect(h.runtime.commands.execute('commerce.order.checkoutCart', original, { actor: buyer, idempotencyKey: key }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: {
        kind: 'order_lines_rejected', lines: expect.arrayContaining([
          expect.objectContaining({ productId: rising.id, reason: 'price_changed', currentUnitPriceCents: 1_200 }),
          expect.objectContaining({ productId: falling.id, reason: 'price_changed', currentUnitPriceCents: 1_800 }),
        ]),
      } });
    const before = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${buyer.customerId}
    `);
    expect(before.rows[0].count).toBe('0');
    for (const product of [rising, falling, healthy]) {
      const stock = await h.runtime.queries.execute<{ reserved: number }>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
      expect(stock.reserved).toBe(0);
    }

    const confirmedPrices = original.confirmedPrices.map((line) => ({ ...line,
      unitPriceCents: line.productId === rising.id ? 1_200 : line.productId === falling.id ? 1_800 : line.unitPriceCents,
    }));
    const order = await h.runtime.commands.execute<{ id: string; lines: { productId: string; unitPriceCents: number }[] }>(
      'commerce.order.checkoutCart', { ...original, confirmedPrices }, { actor: buyer, idempotencyKey: key },
    );
    expect(order.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: rising.id, unitPriceCents: 1_200 }),
      expect.objectContaining({ productId: falling.id, unitPriceCents: 1_800 }),
    ]));
  });
});
