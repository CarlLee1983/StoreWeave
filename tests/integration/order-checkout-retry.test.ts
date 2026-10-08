import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@storeweave/contracts';
import { inventoryService } from '@storeweave/inventory';
import {
  ADMIN_ACTOR, checkoutInput, createCustomer, createHarness, createProduct, stockUp, type TestHarness,
} from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

type Customer = Awaited<ReturnType<typeof createCustomer>>;

async function cartFor(customer: Customer, lines: { productId: string; quantity: number }[]) {
  for (const line of lines) {
    await h.runtime.commands.execute('commerce.cart.addToCart', line,
      { actor: customer, idempotencyKey: randomUUID() });
  }
  return (await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer })).id;
}

const checkout = async (customer: Customer, cartId: string, key = randomUUID()) =>
  h.runtime.commands.execute<any>('commerce.order.checkoutCart', await checkoutInput(h, cartId),
    { actor: customer, idempotencyKey: key });

async function countOrders(customer: Customer) {
  const result = await h.runtime.database.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${customer.customerId}
  `);
  return Number(result.rows[0]!.count);
}

const stockOf = (productId: string) => h.runtime.queries.execute<any>(
  'commerce.inventory.getStock', { productId }, { actor: ADMIN_ACTOR },
);

describe('checkout retry and lock ordering', () => {
  it('ORD-09 completes reversed-line concurrent checkouts without a PostgreSQL deadlock', async () => {
    const a = await createProduct(h.runtime);
    const b = await createProduct(h.runtime);
    await stockUp(h.runtime, a.id, 2);
    await stockUp(h.runtime, b.id, 2);
    const [alice, bob] = await Promise.all([createCustomer(h.runtime), createCustomer(h.runtime)]);
    const aliceCart = await cartFor(alice, [{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 1 }]);
    const bobCart = await cartFor(bob, [{ productId: b.id, quantity: 1 }, { productId: a.id, quantity: 1 }]);

    // Pause after each transaction obtains its first stock-row lock. If lock
    // order differs, both transactions reach this barrier and PostgreSQL sees
    // the real cycle. The timeout lets sorted code proceed when one waits on
    // the other's first row instead of hanging at the barrier.
    const originalReserve = inventoryService.reserve;
    const reached = new Set<string>();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const timeout = setTimeout(release, 500);
    const spy = vi.spyOn(inventoryService, 'reserve').mockImplementation(async (ctx, input) => {
      const result = await originalReserve(ctx, input);
      if (!reached.has(ctx.correlationId)) {
        reached.add(ctx.correlationId);
        if (reached.size === 2) release();
        await barrier;
      }
      return result;
    });
    try {
      const results = await Promise.allSettled([checkout(alice, aliceCart), checkout(bob, bobCart)]);
      expect(results.map((result) => result.status === 'rejected'
        ? { status: result.status, code: (result.reason as { code?: string }).code }
        : { status: result.status })).toEqual([{ status: 'fulfilled' }, { status: 'fulfilled' }]);
      expect(await countOrders(alice)).toBe(1);
      expect(await countOrders(bob)).toBe(1);
      expect(await stockOf(a.id)).toMatchObject({ onHand: 2, reserved: 2, available: 0 });
      expect(await stockOf(b.id)).toMatchObject({ onHand: 2, reserved: 2, available: 0 });
    } finally {
      clearTimeout(timeout);
      spy.mockRestore();
    }
  });

  it('ORD-18 returns a temporary error after inconclusive attempts and permits same-key retry', async () => {
    const customer = await createCustomer(h.runtime);
    const item = await createProduct(h.runtime);
    await stockUp(h.runtime, item.id, 1);
    const cartId = await cartFor(customer, [{ productId: item.id, quantity: 1 }]);
    const key = randomUUID();
    const spy = vi.spyOn(inventoryService, 'reserve').mockRejectedValue(
      PlatformError.conflict('Injected reservation conflict with stock still available'),
    );
    try {
      await expect(checkout(customer, cartId, key)).rejects.toMatchObject({
        code: 'CONFLICT', message: expect.stringContaining('暫時無法處理'),
      });
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
    expect(await countOrders(customer)).toBe(0);
    expect(await stockOf(item.id)).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
    const claimed = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_idempotency WHERE key = ${key}
    `);
    expect(Number(claimed.rows[0]!.count)).toBe(0);

    const order = await checkout(customer, cartId, key);
    expect(order.status).toBe('pending');
    expect(await countOrders(customer)).toBe(1);
    expect(await stockOf(item.id)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
  });
});
