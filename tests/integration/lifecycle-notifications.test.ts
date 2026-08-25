import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, checkoutInput, createHarness, createProduct, defaultCustomer, payOrder, placeOrder, runJobsUntilProcessed, settleWorker, stockUp, type TestHarness,
} from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

async function lifecycleDeliveries(harness: TestHarness, orderId: string) {
  return harness.runtime.queries.execute<{ items: any[] }>(
    'commerce.notification.listLifecycleDeliveries', { orderId, limit: 20 }, { actor: ADMIN_ACTOR },
  );
}

async function paidOrderWithShipment(harness: TestHarness) {
  const product = await createProduct(harness.runtime, { priceCents: 4900 });
  await stockUp(harness.runtime, product.id, 10);
  const customer = await defaultCustomer(harness.runtime);
  await harness.runtime.commands.execute('commerce.cart.addToCart', { productId: product.id, quantity: 1 }, {
    actor: customer, idempotencyKey: randomUUID(),
  });
  const cart = await harness.runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor: customer });
  const order = await harness.runtime.commands.execute<any>(
    'commerce.order.checkoutCart', checkoutInput(harness, cart.id), { actor: customer, idempotencyKey: randomUUID() },
  );
  await payOrder(harness.runtime, order.id);
  // Mock payment confirmation is a worker job; a shipment may only be created
  // after the payment event has made the order durable as paid.
  await runJobsUntilProcessed(harness.worker);
  const shipment = await harness.runtime.commands.execute<any>(
    'commerce.shipping.createShipment', { orderId: order.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
  await harness.runtime.commands.execute(
    'commerce.shipping.advanceShipmentStage', { shipmentId: shipment.id, status: 'shipped' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
  await harness.runtime.commands.execute(
    'commerce.shipping.advanceShipmentStage', { shipmentId: shipment.id, status: 'arrived' }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
  return { order, shipment };
}

describe('訂單生命週期通知', () => {
  it('下單、付款、出貨、到貨各產生一筆有 provider 證據的通知', async () => {
    const { order, shipment } = await paidOrderWithShipment(h);
    await settleWorker(h.worker);

    const rows = (await lifecycleDeliveries(h, order.id)).items;
    expect(rows.map((row) => row.template).sort()).toEqual([
      'customer.order-paid', 'customer.order-placed', 'customer.shipment-arrived', 'customer.shipment-shipped',
    ]);
    for (const row of rows) {
      expect(row.status).toBe('sent');
      expect(row.providerRef).toMatch(/^mock_/);
      expect(row.reference).toContain(row.eventId);
      expect(row.attempts).toBe(1);
    }
    // 營運清單刻意不帶 variables（工單 73）：那份 payload 有顧客姓名與訂單細節。
    // 要驗投遞內容就讀 system-only 的單筆查詢——admin 的 `*` 也拿不到，那是刻意的。
    const shipped = rows.find((row) => row.template === 'customer.shipment-shipped')!;
    const full = await h.runtime.queries.execute<{ variables: Record<string, unknown> }>(
      'commerce.notification.getLifecycleDelivery', { id: shipped.id },
      { actor: { id: 'system', type: 'system', displayName: 'system', permissions: ['*'] } },
    );
    expect(full.variables).toMatchObject({ shipmentId: shipment.id });
  });

  it('重複 worker drain 不重送同一 event/template', async () => {
    const { order } = await paidOrderWithShipment(h);
    await settleWorker(h.worker);
    const before = (await lifecycleDeliveries(h, order.id)).items;
    await settleWorker(h.worker);
    const after = (await lifecycleDeliveries(h, order.id)).items;
    expect(after).toHaveLength(4);
    expect(after.map((row) => [row.eventId, row.template, row.providerRef]).sort())
      .toEqual(before.map((row) => [row.eventId, row.template, row.providerRef]).sort());
  });

  it('provider failure is recorded before the retryable job is returned to pending', async () => {
    const failing = await createHarness({
      extensions: { 'mock-payment': { autoApprove: true }, 'mock-notification': { deliver: false }, mcp: {} },
    });
    try {
      const product = await createProduct(failing.runtime);
      await stockUp(failing.runtime, product.id, 2);
      const order = await placeOrder(failing.runtime, product.id);
      await settleWorker(failing.worker);

      const rows = (await lifecycleDeliveries(failing, order.id)).items;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ template: 'customer.order-placed', status: 'failed' });
      expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
      const jobs = await failing.runtime.database.db.execute<{ status: string; last_error: string | null }>(sql`
        SELECT status, last_error FROM platform_jobs WHERE type = 'commerce.notification.deliver-lifecycle'
      `);
      expect(jobs.rows).toContainEqual(expect.objectContaining({ status: 'pending', last_error: expect.stringContaining('delivery disabled') }));
      const current = await failing.runtime.queries.execute<any>('commerce.order.getOrder', { id: order.id }, { actor: ADMIN_ACTOR });
      expect(current.status).toBe('pending');
    } finally {
      await failing.close();
    }
  });
});
