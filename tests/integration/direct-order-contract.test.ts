import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer, SESSION_COOKIE } from '@storeweave/api';
import { csrfTokenFor } from '@storeweave/identity';
import { defaultTheme } from '@storeweave/theme-default';
import { defineCommand } from '@storeweave/contracts';
import { requestHash } from '../../packages/platform/command-bus/src/hash';
import { ADMIN_ACTOR, createCustomer, createHarness, createProduct, directOrderInput, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
let app: NestFastifyApplication;
beforeAll(async () => {
  h = await createHarness();
  app = await createServer({ runtime: h.runtime, theme: defaultTheme, release: { version: 'test', configPath: '<test>' } });
}, 300_000);
afterAll(async () => { await app?.close(); await h?.close(); });
type Buyer = Awaited<ReturnType<typeof createCustomer>>;
type Input = Awaited<ReturnType<typeof directOrderInput>>;
const place = (buyer: Buyer, input: unknown, key = randomUUID()) =>
  h.runtime.commands.execute<any>('commerce.order.placeOrder', input, { actor: buyer, idempotencyKey: key });
const stock = (id: string) => h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: id }, { actor: ADMIN_ACTOR });
async function fixture() {
  const buyer = await createCustomer(h.runtime);
  const product = await createProduct(h.runtime, { priceCents: 1_000 });
  await stockUp(h.runtime, product.id, 5);
  return { buyer, product, input: await directOrderInput(h.runtime, [{ productId: product.id, quantity: 1 }]) };
}
async function orders(buyer: Buyer) {
  const rows = await h.runtime.database.db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM order_orders WHERE customer_id = ${buyer.customerId}`);
  return Number(rows.rows[0]!.count);
}
async function keys(key: string) {
  const rows = await h.runtime.database.db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM platform_idempotency WHERE key = ${key}`);
  return Number(rows.rows[0]!.count);
}
async function http(buyer: Buyer, input: unknown, key: string) {
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: buyer.email, password: 'test-password' } });
  const session = login.cookies.find((cookie) => cookie.name === SESSION_COOKIE)!.value;
  return app.inject({ method: 'POST', url: '/api/v1/orders', payload: input as Record<string, unknown>,
    cookies: { [SESSION_COOKIE]: session }, headers: { 'x-csrf-token': csrfTokenFor(session), 'idempotency-key': key } });
}
async function legacy(buyer: Buyer, input: Input, key: string, status = 'completed') {
  const seedKey = randomUUID();
  const order = await place(buyer, input, seedKey);
  // Reconstitute a pre-upgrade direct order: it had no delivery and only a global key.
  await h.runtime.database.db.execute(sql`DELETE FROM order_deliveries WHERE order_id = ${order.id}`);
  await h.runtime.database.db.execute(sql`DELETE FROM platform_idempotency WHERE key = ${seedKey}`);
  const hash = requestHash({ currency: input.currency, lines: input.lines, metadata: input.metadata });
  await h.runtime.database.db.execute(sql`INSERT INTO platform_idempotency(command_name,key,request_hash,status,actor_id,response)
    VALUES ('commerce.order.placeOrder',${key},${hash},${status},${buyer.id},${JSON.stringify({ ...order, delivery: null })}::jsonb)`);
  return order;
}

describe('SW-185 direct order confirmation and SW-186 legacy guard', () => {
  it('creates a Customer home delivery through HTTP, freezes its snapshot and replays without repricing', async () => {
    const { buyer, product, input } = await fixture();
    const key = randomUUID();
    const response = await http(buyer, input, key);
    expect(response.statusCode).toBe(201);
    const order = response.json().data;
    expect(order).toMatchObject({ totalCents: 1_000, shippingCents: 0, delivery: { destination: input.destination } });
    await h.runtime.commands.execute('commerce.catalog.updateProduct', { id: product.id, name: 'Changed', priceCents: 2_000 }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const replay = await place(buyer, input, key);
    expect(replay.id).toBe(order.id);
    expect(replay.lines[0].unitPriceCents).toBe(1_000);
    expect(replay.delivery.destination).toEqual(order.delivery.destination);
    expect((await place(buyer, { ...input, confirmedShippingCents: 9_999 }, key)).id).toBe(order.id);
    expect(await orders(buyer)).toBe(1);
    expect(await stock(product.id)).toMatchObject({ onHand: 5, reserved: 1 });
    for (const changed of [
      { ...input, confirmedPrices: [{ productId: product.id, unitPriceCents: 2_000 }] },
      { ...input, destination: { ...input.destination, recipient: 'Another' } },
      { ...input, metadata: { changed: true } },
    ]) await expect(place(buyer, changed, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('rejects higher/lower prices and stale fees atomically, then accepts the same key after confirmation', async () => {
    const { buyer, product, input } = await fixture();
    const key = randomUUID();
    for (const price of [999, 1_001]) {
      await expect(place(buyer, { ...input, confirmedPrices: [{ productId: product.id, unitPriceCents: price }] }, key))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { kind: 'order_lines_rejected', lines: [{ reason: 'price_changed', currentUnitPriceCents: 1_000 }] } });
    }
    await expect(place(buyer, { ...input, confirmedShippingCents: 1 }, key))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { kind: 'shipping_fee_changed', currentShippingCents: 0 } });
    expect(await orders(buyer)).toBe(0);
    expect(await keys(key)).toBe(0);
    expect(await stock(product.id)).toMatchObject({ onHand: 5, reserved: 0 });
    expect((await place(buyer, input, key)).id).toBeDefined();
  });

  it('requires exact distinct product confirmations and rejects unverified pickup or old request shapes', async () => {
    const { buyer, product, input } = await fixture();
    for (const bad of [
      { lines: input.lines },
      { ...input, confirmedPrices: [] },
      { ...input, confirmedPrices: [input.confirmedPrices[0], input.confirmedPrices[0]] },
      { ...input, confirmedPrices: [...input.confirmedPrices, { productId: randomUUID(), unitPriceCents: 1 }] },
      { ...input, confirmedPrices: [{ productId: randomUUID(), unitPriceCents: 1 }] },
      { ...input, destination: { kind: 'pickup_store', providerStoreId: 'fake', storeName: 'fake', storeAddress: 'fake', recipient: 'Buyer', phone: '123' } },
      { ...input, confirmedShippingCents: undefined },
    ]) await expect(place(buyer, bad)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await orders(buyer)).toBe(0);
    expect(await stock(product.id)).toMatchObject({ reserved: 0 });
  });

  it('isolates equal raw keys by Customer and serializes concurrent same-Customer retries', async () => {
    const { buyer, product, input } = await fixture();
    const bob = await createCustomer(h.runtime);
    const key = randomUUID();
    const result = await Promise.all([place(buyer, input, key), place(buyer, input, key), place(bob, input, key)]);
    expect(result[0].id).toBe(result[1].id);
    expect(result[2].id).not.toBe(result[0].id);
    expect(await orders(buyer)).toBe(1);
    expect(await orders(bob)).toBe(1);
    expect(await stock(product.id)).toMatchObject({ reserved: 2 });
  });

  it('normalizes price ordering and address whitespace but preserves purchase-line order for pricing', async () => {
    const { buyer, product } = await fixture();
    const other = await createProduct(h.runtime, { priceCents: 1_000 });
    await stockUp(h.runtime, other.id, 5);
    const input = await directOrderInput(h.runtime, [{ productId: product.id, quantity: 1 }, { productId: other.id, quantity: 1 }]);
    const key = randomUUID();
    const order = await place(buyer, input, key);
    const equivalent = { ...input, confirmedPrices: [...input.confirmedPrices].reverse(), destination: { ...input.destination, recipient: ` ${input.destination.recipient} `, line2: '' } };
    expect((await place(buyer, equivalent, key)).id).toBe(order.id);
    await expect(place(buyer, { ...input, lines: [...input.lines].reverse() }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('refuses owned historical keys through HTTP with the original identity and no new delivery or claim', async () => {
    const { buyer, product, input } = await fixture();
    const key = randomUUID();
    const old = await legacy(buyer, input, key);
    const effects = () => h.runtime.database.db.execute(sql`SELECT
      (SELECT count(*) FROM platform_audit_log WHERE resource_id = ${old.id}) AS audits,
      (SELECT count(*) FROM platform_outbox WHERE payload->>'orderId' = ${old.id}) AS events`);
    const before = (await effects()).rows;
    const response = await http(buyer, input, key);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('配送資料未套用'), details: { kind: 'legacy_order_exists', orderId: old.id, orderNumber: old.number } });
    expect(await orders(buyer)).toBe(1);
    expect((await effects()).rows).toEqual(before);
    expect(await keys(key)).toBe(1);
    expect(await stock(product.id)).toMatchObject({ reserved: 1 });
    const delivery = await h.runtime.database.db.execute(sql`SELECT * FROM order_deliveries WHERE order_id = ${old.id}`);
    expect(delivery.rows).toHaveLength(0);
    await expect(place(buyer, { ...input, lines: [{ productId: product.id, quantity: 2 }] }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('ignores a foreign historical key before examining its hash, incomplete status or malformed response', async () => {
    const { buyer, input } = await fixture();
    const bob = await createCustomer(h.runtime);
    const key = randomUUID();
    await legacy(buyer, input, key);
    await h.runtime.database.db.execute(sql`UPDATE platform_idempotency SET request_hash = 'different', status = 'in_progress', response = '{}'::jsonb WHERE key = ${key}`);
    const order = await place(bob, input, key);
    expect(order.customerId).toBe(bob.customerId);
    expect(await orders(bob)).toBe(1);
    expect(await keys(key)).toBe(2);
  });

  it('refuses owned incomplete historical requests without claiming a scoped key', async () => {
    const { buyer, input } = await fixture();
    const key = randomUUID();
    await legacy(buyer, input, key, 'in_progress');
    await expect(place(buyer, input, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect(await keys(key)).toBe(1);
    expect(await orders(buyer)).toBe(1);
  });

  it('fails closed when a JavaScript legacy callback unexpectedly returns', async () => {
    const buyer = await createCustomer(h.runtime);
    const key = randomUUID();
    const name = `test.legacy_${randomUUID().replaceAll('-', '')}`;
    let calls = 0;
    const descriptor = defineCommand({ name, input: z.object({}), output: z.object({}), permission: 'order:write',
      idempotency: 'required', idempotencyScope: 'actor',
      // Deliberately violate the callback type to simulate a JavaScript extension.
      legacyIdempotencyGuard: { input: (input) => input, onReplay: () => undefined as never } });
    h.runtime.commands.register(descriptor, async () => { calls++; return {}; }, 'test');
    await h.runtime.database.db.execute(sql`INSERT INTO platform_idempotency(command_name,key,request_hash,status,actor_id,response)
      VALUES (${name},${key},${requestHash({})},'completed',${buyer.id},'{}'::jsonb)`);
    await expect(h.runtime.commands.execute(name, {}, { actor: buyer, idempotencyKey: key }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'Legacy idempotency guard returned without refusing replay' });
    expect(calls).toBe(0);
    expect(await keys(key)).toBe(1);
  });

  it('rejects an invalid legacy policy registration without changing unrelated command defaults', () => {
    const descriptor = defineCommand({ name: `test.legacy.${randomUUID()}`, input: z.object({}), output: z.object({}), permission: 'order:write', idempotency: 'required',
      legacyIdempotencyGuard: { input: (input) => input, onReplay: () => { throw new Error('not called'); } } });
    expect(() => h.runtime.commands.register(descriptor, async () => ({}), 'test')).toThrow(/actor-scoped required/);
  });
});
