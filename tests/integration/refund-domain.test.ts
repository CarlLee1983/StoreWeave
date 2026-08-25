import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '@storeweave/contracts';
import { actorWith, ADMIN_ACTOR, checkoutInput, createHarness, createProduct, defaultCustomer, payOrder, runJobsUntilProcessed, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

async function paidOrder() {
  const product = await createProduct(h.runtime, { priceCents: 1200 });
  await stockUp(h.runtime, product.id, 2);
  const customer = await defaultCustomer(h.runtime);
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, { actor: customer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', checkoutInput(h, cart.id), { actor: customer, idempotencyKey: randomUUID() });
  await payOrder(h.runtime, order.id);
  expect(await runJobsUntilProcessed(h.worker)).toMatchObject({ processed: 1, failed: 0 });
  return order;
}

describe('Ticket 63: refund domain and operations', () => {
  it('creates one auditable full refund for a paid unfulfilled order and never duplicates it', async () => {
    const order = await paidOrder();
    const key = randomUUID();
    const first = await h.runtime.commands.execute<any>('commerce.refund.requestFullRefund', { orderId: order.id, reason: 'customer changed mind' }, { actor: ADMIN_ACTOR, idempotencyKey: key });
    const replay = await h.runtime.commands.execute<any>('commerce.refund.requestFullRefund', { orderId: order.id, reason: 'customer changed mind' }, { actor: ADMIN_ACTOR, idempotencyKey: key });
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({ orderId: order.id, amountCents: 1300, status: 'requested', attemptNo: 1, paymentProvider: 'mock-payment' });
    await expect(h.runtime.commands.execute('commerce.refund.requestFullRefund', { orderId: order.id, reason: 'double submit' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow(/already has a direct refund/);

    const listed = await h.runtime.queries.execute<any>('commerce.refund.listRefunds', { orderId: order.id }, { actor: ADMIN_ACTOR });
    expect(listed.items).toHaveLength(1);
    const audit = await h.runtime.audit.list(h.runtime.database.db, { resourceType: 'refund', resourceId: first.id });
    expect(audit.map((entry) => entry.action)).toContain('refund.requested');
  });

  it('serializes simultaneous distinct refund submissions into one record', async () => {
    const order = await paidOrder();
    const results = await Promise.allSettled([
      h.runtime.commands.execute('commerce.refund.requestFullRefund', { orderId: order.id, reason: 'first' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }),
      h.runtime.commands.execute('commerce.refund.requestFullRefund', { orderId: order.id, reason: 'second' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await h.runtime.queries.execute<any>('commerce.refund.listRefunds', { orderId: order.id }, { actor: ADMIN_ACTOR })).items).toHaveLength(1);
  });

  it('keeps provider results system-only and exposes only a safe customer projection', async () => {
    const order = await paidOrder();
    const refund = await h.runtime.commands.execute<any>('commerce.refund.requestFullRefund', { orderId: order.id, reason: 'duplicate item' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await expect(h.runtime.commands.execute('commerce.refund.recordRefundResult', { id: refund.id, paymentProvider: refund.paymentProvider, providerRequestRef: refund.providerRequestRef, status: 'succeeded', providerRefundRef: 'mock-refund-1' }, { actor: actorWith(['refund:write']), idempotencyKey: randomUUID() })).rejects.toThrow(/FORBIDDEN|forbidden/i);
    await h.worker.drain();
    const settled = await h.runtime.queries.execute<any>('commerce.refund.getRefund', { id: refund.id }, { actor: ADMIN_ACTOR });
    expect(settled.status).toBe('succeeded');
    const line = (await h.runtime.queries.execute<any>('commerce.order.getOrder', { id: order.id }, { actor: ADMIN_ACTOR })).lines[0];
    expect((await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: line.productId }, { actor: ADMIN_ACTOR })).onHand).toBe(2);
    const customer = await defaultCustomer(h.runtime);
    const safe = await h.runtime.queries.execute<any>('commerce.refund.getRefund', { id: refund.id }, { actor: customer });
    expect(safe).toMatchObject({ id: refund.id, status: 'succeeded' });
    expect(safe).not.toHaveProperty('reason');
    expect(safe).not.toHaveProperty('providerRefundRef');
    expect(safe).not.toHaveProperty('providerRequestRef');
  });

  it('serializes refunds with fulfilment and does not permit retry after shipment begins', async () => {
    const order = await paidOrder();
    const refund = await h.runtime.commands.execute<any>('commerce.refund.requestFullRefund', { orderId: order.id, reason: 'damaged box' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await expect(h.runtime.commands.execute('commerce.shipping.createShipment', { orderId: order.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow(/direct refund/);
    await h.runtime.commands.execute('commerce.refund.recordRefundResult', { id: refund.id, paymentProvider: refund.paymentProvider, providerRequestRef: refund.providerRequestRef, status: 'failed', failureMessage: 'provider declined' }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    await h.runtime.commands.execute('commerce.shipping.createShipment', { orderId: order.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    await expect(h.runtime.commands.execute('commerce.refund.retryRefund', { id: refund.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow(/entered fulfilment/);
  });
});
