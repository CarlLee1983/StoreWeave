import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaymentProviderV2 } from '@storeweave/extension-sdk';
import {
  ADMIN_ACTOR, checkoutInput, createCustomer, createHarness, createProduct, defaultCustomer, payOrder, runJobsUntilProcessed, stockUp, type TestHarness,
} from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

async function shippedOrder(quantity = 1) {
  const product = await createProduct(h.runtime, { priceCents: 1200 });
  await stockUp(h.runtime, product.id, quantity + 2);
  const customer = await defaultCustomer(h.runtime);
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity }, { actor: customer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', checkoutInput(h, cart.id), { actor: customer, idempotencyKey: randomUUID() });
  await payOrder(h.runtime, order.id);
  await runJobsUntilProcessed(h.worker);
  const shipment = await h.runtime.commands.execute<any>('commerce.shipping.createShipment', { orderId: order.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  await h.runtime.commands.execute('commerce.shipping.advanceShipmentStage', { shipmentId: shipment.id, status: 'shipped' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
  return { customer, order, product };
}

async function waitForRmaStatus(id: string, actor: Awaited<ReturnType<typeof defaultCustomer>>, status: string) {
  let current = 'unknown';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await h.worker.drain();
    const rma = await h.runtime.queries.execute<any>('commerce.rma.getRma', { id }, { actor });
    current = rma.status;
    if (rma.status === status) return rma;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`RMA ${id} did not reach ${status} (current=${current})`);
}

describe('Ticket 65: RMA domain and operations', () => {
  it('only lets the order owner create a quantity-bounded RMA after shipment, and rejection releases its quantity', async () => {
    const { customer, order } = await shippedOrder(2);
    const line = order.lines[0];
    const first = await h.runtime.commands.execute<any>('commerce.rma.createRma', { orderId: order.id, reason: 'size unsuitable', lines: [{ orderLineId: line.id, quantity: 2 }] }, { actor: customer, idempotencyKey: randomUUID() });
    await expect(h.runtime.commands.execute('commerce.rma.createRma', { orderId: order.id, reason: 'duplicate', lines: [{ orderLineId: line.id, quantity: 1 }] }, { actor: customer, idempotencyKey: randomUUID() })).rejects.toThrow(/quantity exceeds/);
    await h.runtime.commands.execute('commerce.rma.rejectRma', { id: first.id, note: 'outside return window' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const again = await h.runtime.commands.execute<any>('commerce.rma.createRma', { orderId: order.id, reason: 'new evidence', lines: [{ orderLineId: line.id, quantity: 1 }] }, { actor: customer, idempotencyKey: randomUUID() });
    expect(again.status).toBe('requested');
    const other = await createCustomer(h.runtime);
    await expect(h.runtime.commands.execute('commerce.rma.createRma', { orderId: order.id, reason: 'not mine', lines: [{ orderLineId: line.id, quantity: 1 }] }, { actor: other, idempotencyKey: randomUUID() })).rejects.toThrow(/Order/);
  });

  it('does not restock before receipt, requires a disposition, and settles a linked partial refund without direct-refund reversals', async () => {
    const { customer, order, product } = await shippedOrder();
    const provider = h.runtime.providers.get<PaymentProviderV2>('payment', 'mock-payment');
    const originalRefund = provider.refund.bind(provider);
    const refundCalls: Parameters<PaymentProviderV2['refund']>[0][] = [];
    let failFirstRefund = true;
    provider.refund = async (input) => {
      refundCalls.push(input);
      if (failFirstRefund) {
        failFirstRefund = false;
        return { status: 'rejected', message: 'temporary provider failure' };
      }
      return originalRefund(input);
    };
    const line = order.lines[0];
    const rma = await h.runtime.commands.execute<any>('commerce.rma.createRma', { orderId: order.id, reason: 'damaged', lines: [{ orderLineId: line.id, quantity: 1 }] }, { actor: customer, idempotencyKey: randomUUID() });
    await h.runtime.commands.execute('commerce.rma.approveRma', { id: rma.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    expect((await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR })).onHand).toBe(2);
    await expect(h.runtime.commands.execute('commerce.rma.receiveRma', { id: rma.id, lines: [{ rmaLineId: rma.lines[0].id, disposition: 'discard' }] }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() })).rejects.toThrow(/Invalid input/);
    const received = await h.runtime.commands.execute<any>('commerce.rma.receiveRma', { id: rma.id, lines: [{ rmaLineId: rma.lines[0].id, disposition: 'restock' }] }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    expect(received.status).toBe('received');
    expect((await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR })).onHand).toBe(3);
    const pending = await h.runtime.commands.execute<any>('commerce.rma.requestRefund', { id: rma.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    expect(pending).toMatchObject({ status: 'refund_pending' });
    const refund = await h.runtime.queries.execute<any>('commerce.refund.getRefund', { id: pending.refundId }, { actor: ADMIN_ACTOR });
    expect(refund).toMatchObject({ source: 'rma', sourceRef: rma.id, amountCents: 1200 });
    await waitForRmaStatus(rma.id, customer, 'refund_failed');
    expect(refundCalls[0]).toMatchObject({
      amount: refund.amountCents,
      currency: refund.currency,
      reference: refund.providerRequestRef,
    });
    expect(refundCalls[0].providerRef).toMatch(/^mock_/);
    expect(refundCalls[0]).not.toHaveProperty('amountCents');
    const retried = await h.runtime.commands.execute<any>('commerce.refund.retryRefund', { id: refund.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const completed = await waitForRmaStatus(rma.id, customer, 'completed');
    expect(refundCalls[1]).toMatchObject({
      amount: refund.amountCents,
      currency: refund.currency,
      reference: retried.providerRequestRef,
    });
    expect(refundCalls[1].providerRef).toBe(refundCalls[0].providerRef);
    expect(refundCalls[1]).not.toHaveProperty('amountCents');
    expect(retried.providerRequestRef).not.toBe(refund.providerRequestRef);
    // The RMA receipt itself did the only restock; provider success must not run direct-refund's whole-order reversal.
    expect((await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR })).onHand).toBe(3);
  });
});
