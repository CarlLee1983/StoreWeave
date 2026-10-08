import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '@storeweave/contracts';
import { defaultCustomer, ADMIN_ACTOR, createHarness, directOrderInput, createProduct, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

async function adjust(productId: string, delta: number, key: string) {
  return h.runtime.commands.execute<{ onHand: number }>(
    'commerce.inventory.adjustStock', { productId, delta, reason: 'restock' }, { actor: ADMIN_ACTOR, idempotencyKey: key },
  );
}

describe('Idempotency', () => {
  it('bounded retries restart rolled-back transactions with the same key and leave defaults untouched', async () => {
    const name = `probe.idempotency.retry_${randomUUID().replaceAll('-', '')}`;
    let attempts = 0;
    let failing = true;
    let uncertain = false;
    const product = await createProduct(h.runtime);
    await stockUp(h.runtime, product.id, 1);
    const descriptor = defineCommand({
      name, input: z.object({}).strict(), output: z.object({ count: z.number() }),
      permission: 'inventory:write', idempotency: 'required',
      transactionRetry: { maxAttempts: 3, shouldRetry: error => error instanceof Error && error.message === 'classified failure',
        exhaustedMessage: '暫時無法處理，請以原識別鍵重試' },
    });
    h.runtime.commands.register(descriptor, async (_input, ctx) => {
      attempts++;
      await ctx.tx.execute(sql`UPDATE inventory_stock SET on_hand = on_hand + 10 WHERE product_id = ${product.id}`);
      if (uncertain) throw new Error('unclassified connection outcome');
      if (failing) throw new Error('classified failure');
      return { count: attempts };
    }, 'probe');
    const key = randomUUID();
    const options = { actor: ADMIN_ACTOR, idempotencyKey: key };
    await expect(h.runtime.commands.execute(name, {}, options)).rejects.toMatchObject({
      code: 'CONFLICT', message: '暫時無法處理，請以原識別鍵重試',
    });
    expect(attempts).toBe(3);
    const stockAfter = async () => h.runtime.queries.execute<{ onHand: number }>(
      'commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect((await stockAfter()).onHand).toBe(1);
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_idempotency WHERE command_name = ${name} AND key = ${key}
    `);
    expect(Number(rows.rows[0].count)).toBe(0);
    failing = false;
    expect(await h.runtime.commands.execute(name, {}, options)).toEqual({ count: 4 });
    expect(await h.runtime.commands.execute(name, {}, options)).toEqual({ count: 4 });
    expect(attempts).toBe(4);
    expect((await stockAfter()).onHand).toBe(11);
    uncertain = true;
    await expect(h.runtime.commands.execute(name, {}, { ...options, idempotencyKey: randomUUID() }))
      .rejects.toThrow('unclassified connection outcome');
    expect(attempts).toBe(5);
    expect((await stockAfter()).onHand).toBe(11);
  });

  it('actor-scoped commands isolate equal keys and project replay facts without changing default commands', async () => {
    const name = `probe.idempotency.scoped_${randomUUID().replaceAll('-', '')}`;
    const descriptor = defineCommand({
      name, input: z.object({ value: z.number(), confirmation: z.number() }).strict(),
      output: z.object({ count: z.number() }), permission: 'inventory:write',
      idempotency: 'required', idempotencyScope: 'actor',
      idempotencyInput: input => ({ value: input.value }),
    });
    let handled = 0;
    h.runtime.commands.register(descriptor, async () => ({ count: ++handled }), 'probe');
    const key = randomUUID();
    const alice = { ...ADMIN_ACTOR, id: `probe:alice:${randomUUID()}` };
    const bob = { ...ADMIN_ACTOR, id: `probe:bob:${randomUUID()}` };
    expect(() => h.runtime.commands.register({ ...descriptor, name: JSON.stringify([name, alice.id]),
      idempotencyScope: undefined }, async () => ({ count: 999 }), 'probe'))
      .toThrow('reserved idempotency namespace');
    const execute = (actor: typeof alice, value: number, confirmation: number) =>
      h.runtime.commands.execute(name, { value, confirmation }, { actor, idempotencyKey: key });
    expect(await execute(alice, 1, 100)).toEqual({ count: 1 });
    expect(await execute(bob, 2, 100)).toEqual({ count: 2 });
    expect(await execute(alice, 1, 200)).toEqual({ count: 1 });
    expect(await execute(bob, 2, 200)).toEqual({ count: 2 });
    await expect(execute(alice, 3, 200)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    expect(handled).toBe(2);
    const rows = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_idempotency
      WHERE command_name IN (${JSON.stringify([name, alice.id])}, ${JSON.stringify([name, bob.id])})
        AND key = ${key} AND status = 'completed'
    `);
    expect(Number(rows.rows[0].count)).toBe(2);
  });

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
      await directOrderInput(h.runtime, [{ productId: product.id, quantity: 1 }]),
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
