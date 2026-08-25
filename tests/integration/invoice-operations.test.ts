import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ACTOR, checkoutInput, createHarness, createProduct, defaultCustomer, payOrder, settleWorker, stockUp, type TestHarness } from './helpers';

/** 工單 69：發票的營運介面。開立失敗之後，重試要做得完、也只能在失敗狀態做。 */

async function paidOrderInvoice(h: TestHarness) {
  const product = await createProduct(h.runtime, { priceCents: 1200 });
  await stockUp(h.runtime, product.id, 2);
  const customer = await defaultCustomer(h.runtime);
  await h.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, { actor: customer, idempotencyKey: randomUUID() });
  const cart = await h.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  const order = await h.runtime.commands.execute<any>('commerce.order.checkoutCart', { ...checkoutInput(h, cart.id), invoicePreference: { kind: 'ecpay' } }, { actor: customer, idempotencyKey: randomUUID() });
  await payOrder(h.runtime, order.id);
  await settleWorker(h.worker);
  return (await h.runtime.queries.execute<any>('commerce.invoice.list', { orderId: order.id }, { actor: ADMIN_ACTOR })).items[0];
}

const SYSTEM_ACTOR = { id: 'system', type: 'system' as const, displayName: 'system', permissions: ['*'] };

let failing: TestHarness;
let issuing: TestHarness;
let voidFailing: TestHarness;

beforeAll(async () => {
  failing = await createHarness({ extensions: { 'mock-payment': { autoApprove: true }, 'mock-invoice': { issue: false }, mcp: {} } });
  issuing = await createHarness({ extensions: { 'mock-payment': { autoApprove: true }, 'mock-invoice': {}, mcp: {} } });
  voidFailing = await createHarness({ extensions: { 'mock-payment': { autoApprove: true }, 'mock-invoice': { void: false }, mcp: {} } });
}, 300_000);
afterAll(async () => { await failing?.close(); await issuing?.close(); await voidFailing?.close(); });

describe('工單 69：發票開立失敗後的重試', () => {

  it('lets an operator re-attempt a failed issue and counts the new attempt', async () => {
    const invoice = await paidOrderInvoice(failing);
    expect(invoice).toMatchObject({ status: 'issue_failed', issueAttempts: 1, lastError: 'mock issue disabled' });

    const retried = await failing.runtime.commands.execute<any>('commerce.invoice.retryIssue', { id: invoice.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    expect(retried.status).toBe('issue_failed');
    await settleWorker(failing.worker);

    const after = await failing.runtime.queries.execute<any>('commerce.invoice.get', { id: invoice.id }, { actor: ADMIN_ACTOR });
    // 恰好一次，不是「有變多」：這支測試要守住的是第二次失敗沒有被第一次的冪等鍵吃掉。
    expect(after.issueAttempts).toBe(2);
    expect(Object.keys(after)).not.toContain('customer');
    expect(Object.keys(after)).not.toContain('lines');
  });

  it('refuses to re-attempt an invoice that is already issued', async () => {
    const invoice = await paidOrderInvoice(issuing);
    expect(invoice.status).toBe('issued');
    await expect(issuing.runtime.commands.execute('commerce.invoice.retryIssue', { id: invoice.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }))
      .rejects.toThrow(/cannot be re-attempted from issued/);
  });
});

describe('工單 69：發票作廢失敗後的重試', () => {
  it('puts a failed void back in flight and counts the new attempt', async () => {
    const invoice = await paidOrderInvoice(voidFailing);
    await voidFailing.runtime.commands.execute('commerce.invoice.queueVoid', { refundId: randomUUID(), orderId: invoice.orderId, amountCents: invoice.amountCents }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });
    await settleWorker(voidFailing.worker);
    const failed = await voidFailing.runtime.queries.execute<any>('commerce.invoice.get', { id: invoice.id }, { actor: ADMIN_ACTOR });
    expect(failed).toMatchObject({ status: 'void_failed', voidAttempts: 1, lastError: 'mock void disabled' });

    const retried = await voidFailing.runtime.commands.execute<any>('commerce.invoice.retryVoid', { id: invoice.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    expect(retried.status).toBe('void_pending');
    await settleWorker(voidFailing.worker);
    expect((await voidFailing.runtime.queries.execute<any>('commerce.invoice.get', { id: invoice.id }, { actor: ADMIN_ACTOR })).voidAttempts).toBeGreaterThan(1);
  });

  it('refuses to re-attempt a void the invoice never entered', async () => {
    const invoice = await paidOrderInvoice(issuing);
    await expect(issuing.runtime.commands.execute('commerce.invoice.retryVoid', { id: invoice.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }))
      .rejects.toThrow(/cannot be re-attempted from issued/);
  });
});

describe('工單 69：重試要重排既有工作，而不是排第二支', () => {
  it('takes a permanently failed issue back out of the dead-letter queue', async () => {
    // 愛心碼在 provider 那一側被拒是 PermanentJobError：工作直接進死信，
    // 而失敗紀錄的冪等鍵是固定的，issueAttempts 因此不會前進。
    const product = await createProduct(failing.runtime, { priceCents: 1200 });
    await stockUp(failing.runtime, product.id, 2);
    const customer = await defaultCustomer(failing.runtime);
    await failing.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, { actor: customer, idempotencyKey: randomUUID() });
    const cart = await failing.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
    const order = await failing.runtime.commands.execute<any>('commerce.order.checkoutCart', { ...checkoutInput(failing, cart.id), invoicePreference: { kind: 'donation', loveCode: '999999' } }, { actor: customer, idempotencyKey: randomUUID() });
    await payOrder(failing.runtime, order.id);
    await settleWorker(failing.worker);

    const invoice = (await failing.runtime.queries.execute<any>('commerce.invoice.list', { orderId: order.id }, { actor: ADMIN_ACTOR })).items[0];
    expect(invoice.status).toBe('issue_failed');
    const deadBefore = await failing.runtime.queries.execute<any>('platform.jobs.listDeadJobs', {}, { actor: ADMIN_ACTOR });
    expect(deadBefore.items.some((job: any) => job.dedupeKey === `invoice:issue:${invoice.id}`)).toBe(true);

    await failing.runtime.commands.execute('commerce.invoice.retryIssue', { id: invoice.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const deadAfter = await failing.runtime.queries.execute<any>('platform.jobs.listDeadJobs', {}, { actor: ADMIN_ACTOR });
    expect(deadAfter.items.some((job: any) => job.dedupeKey?.startsWith(`invoice:issue:${invoice.id}`))).toBe(false);
  });
});
