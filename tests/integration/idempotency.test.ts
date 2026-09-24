import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '@storeweave/contracts';
import { defaultCustomer, ADMIN_ACTOR, createHarness, createProduct, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

async function adjust(productId: string, delta: number, key: string) {
  return h.runtime.commands.execute<{ onHand: number }>(
    'commerce.inventory.adjustStock', { productId, delta, reason: 'restock' }, { actor: ADMIN_ACTOR, idempotencyKey: key },
  );
}

describe('Idempotency', () => {
  it('requires a declared pre-idempotency guard on first execution and replay', async () => {
    const name = `probe.idempotency.guarded_${randomUUID().replaceAll('-', '')}`;
    const descriptor = defineCommand({
      name,
      input: z.object({}).strict(),
      output: z.object({ count: z.number() }),
      permission: 'inventory:write',
      idempotency: 'required',
      requiresBeforeIdempotency: true,
    });
    let handled = 0;
    let guarded = 0;
    h.runtime.commands.register(descriptor, async () => ({ count: ++handled }), 'probe');
    const key = randomUUID();
    const options = { actor: ADMIN_ACTOR, idempotencyKey: key };

    await expect(h.runtime.commands.execute(name, {}, options)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(handled).toBe(0);
    const absent = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_idempotency WHERE command_name = ${name} AND key = ${key}
    `);
    expect(Number(absent.rows[0]?.count)).toBe(0);

    const guardedOptions = { ...options, beforeIdempotency: async () => { guarded++; } };
    await expect(h.runtime.commands.execute(name, {}, guardedOptions)).resolves.toEqual({ count: 1 });
    await expect(h.runtime.commands.execute(name, {}, guardedOptions)).resolves.toEqual({ count: 1 });
    expect(handled).toBe(1);
    expect(guarded).toBe(2);

    await expect(h.runtime.commands.execute(name, {}, {
      ...options, beforeIdempotency: async () => { throw new Error('revoked'); },
    })).rejects.toThrow('revoked');
    expect(handled).toBe(1);
  });

  it('同一個 key 重放會回傳第一次的結果，且不重複執行', async () => {
    const product = await createProduct(h.runtime);
    const key = randomUUID();
    const first = await adjust(product.id, 10, key);
    const second = await adjust(product.id, 10, key);
    expect(second.onHand).toBe(first.onHand);

    const stock = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(stock.onHand).toBe(10);

    const movements = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM inventory_movements WHERE product_id = ${product.id}
    `);
    expect(Number(movements.rows[0].count)).toBe(1);
  });

  it('相同 key 但不同內容會回 IDEMPOTENCY_MISMATCH', async () => {
    const product = await createProduct(h.runtime);
    const key = randomUUID();
    await adjust(product.id, 3, key);
    await expect(adjust(product.id, 4, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('併發送出相同 key 只會有一次生效', async () => {
    const product = await createProduct(h.runtime);
    const key = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => adjust(product.id, 2, key)),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);

    const stock = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(stock.onHand).toBe(2);
  });

  it('key 只在同一個 command 內唯一，不同 command 可以共用字串', async () => {
    const product = await createProduct(h.runtime);
    const key = 'shared-key-1234';
    await adjust(product.id, 5, key);
    const order = await h.runtime.commands.execute<{ id: string }>(
      'commerce.order.placeOrder',
      { lines: [{ productId: product.id, quantity: 1 }] },
      { actor: await defaultCustomer(h.runtime), idempotencyKey: key },
    );
    expect(order.id).toBeTruthy();
  });

  it('失敗的 command 不會佔用 key（交易回滾連 idempotency 紀錄一起回滾）', async () => {
    const product = await createProduct(h.runtime);
    const key = randomUUID();
    await expect(adjust(product.id, -5, key)).rejects.toThrow(/Insufficient stock/);

    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_idempotency WHERE key = ${key}
    `);
    expect(Number(rows.rows[0].count)).toBe(0);

    await stockUp(h.runtime, product.id, 8);
    const retried = await adjust(product.id, -5, key);
    expect(retried.onHand).toBe(3);
  });
});
