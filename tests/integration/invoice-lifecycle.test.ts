import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ACTOR, checkoutInput, createHarness, createProduct, defaultCustomer, payOrder, settleWorker, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness({ extensions: { 'mock-payment': { autoApprove: true }, 'mock-invoice': {}, mcp: {} } }); }, 300_000);
afterAll(async () => { await h?.close(); });

async function paidOrder(invoicePreference: Record<string, unknown>) {
  const product = await createProduct(h.runtime, { priceCents: 1200 });
  await stockUp(h.runtime, product.id, 2);
  const customer = await defaultCustomer(h.runtime);
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, { actor: customer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', { ...checkoutInput(h, cart.id), invoicePreference }, { actor: customer, idempotencyKey: randomUUID() });
  await payOrder(h.runtime, order.id);
  await settleWorker(h.worker);
  return order;
}

describe('Ticket 66: B2C invoice lifecycle', () => {
  it('issues one tax-inclusive B2C invoice after payment, preserving the selected carrier', async () => {
    const order = await paidOrder({ kind: 'mobile', number: '/ABC1234' });
    const invoices = await h.runtime.queries.execute<any>('commerce.invoice.list', { orderId: order.id }, { actor: ADMIN_ACTOR });
    expect(invoices.items).toHaveLength(1);
    expect(invoices.items[0]).toMatchObject({ orderId: order.id, provider: 'mock-invoice', status: 'issued', amountCents: 1300, taxCents: 62, carrier: { kind: 'mobile', number: '/ABC1234' }, issueAttempts: 1 });
    await settleWorker(h.worker);
    expect((await h.runtime.queries.execute<any>('commerce.invoice.list', { orderId: order.id }, { actor: ADMIN_ACTOR })).items).toHaveLength(1);
  });

  it('voids only after a successful full refund and leaves a partial-refund amount untouched', async () => {
    const order = await paidOrder({ kind: 'ecpay' });
    const invoice = (await h.runtime.queries.execute<any>('commerce.invoice.list', { orderId: order.id }, { actor: ADMIN_ACTOR })).items[0];
    await h.runtime.commands.execute('commerce.invoice.queueVoid', { refundId: randomUUID(), orderId: order.id, amountCents: invoice.amountCents - 100 }, { actor: { id: 'system', type: 'system', displayName: 'system', permissions: ['*'] }, idempotencyKey: randomUUID() });
    expect((await h.runtime.queries.execute<any>('commerce.invoice.get', { id: invoice.id }, { actor: ADMIN_ACTOR })).status).toBe('issued');
    await h.runtime.commands.execute('commerce.invoice.queueVoid', { refundId: randomUUID(), orderId: order.id, amountCents: invoice.amountCents }, { actor: { id: 'system', type: 'system', displayName: 'system', permissions: ['*'] }, idempotencyKey: randomUUID() });
    await settleWorker(h.worker);
    expect((await h.runtime.queries.execute<any>('commerce.invoice.get', { id: invoice.id }, { actor: ADMIN_ACTOR })).status).toBe('voided');
  });

  it('rejects invalid carrier syntax before payment is attempted', async () => {
    const product = await createProduct(h.runtime); await stockUp(h.runtime, product.id, 1);
    const customer = await defaultCustomer(h.runtime);
    await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, { actor: customer, idempotencyKey: randomUUID() });
    const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
    await expect(h.runtime.commands.execute('commerce.order.checkoutCart', { ...checkoutInput(h, cart.id), invoicePreference: { kind: 'donation', loveCode: 'not-a-code' } }, { actor: customer, idempotencyKey: randomUUID() })).rejects.toThrow(/Invalid input/);
  });
});
