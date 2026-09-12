import { randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ADMIN_ACTOR, checkoutInput, createHarness, createProduct, defaultCustomer, payOrder, placeOrder, runJobsUntilProcessed, settleWorker, stockUp, type TestHarness,
} from './helpers';
import { SYSTEM_ACTOR } from '@storeweave/contracts';

const servers: SMTPServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

/** 生命週期通知走 base 通知能力，因此這裡的收信端就是一個真的 SMTP。 */
async function smtpSink(options: { rejectAll?: boolean } = {}) {
  const messages: string[] = [];
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS', 'AUTH'],
    onRcptTo(_address, _session, callback) { callback(options.rejectAll ? new Error('550 recipient rejected') : null); },
    onData(stream, _session, callback) {
      stream.on('data', chunk => { messages.push(chunk.toString('utf8')); });
      stream.on('end', callback);
    },
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP sink did not expose a TCP port');
  return { port: address.port, messages };
}

function mailConfig(port: number) {
  return { transport: 'smtp', from: 'store@example.test', smtp: { host: '127.0.0.1', port } };
}

let sink: Awaited<ReturnType<typeof smtpSink>>;
let h: TestHarness;
beforeAll(async () => {
  sink = await smtpSink();
  h = await createHarness({ mail: mailConfig(sink.port) });
}, 300_000);
afterAll(async () => {
  await h?.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

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
  it('下單、付款、出貨、到貨各寄出一封信，並留下可查的投遞證據', async () => {
    const { order, shipment } = await paidOrderWithShipment(h);
    await settleWorker(h.worker);

    const rows = (await lifecycleDeliveries(h, order.id)).items;
    expect(rows.map((row) => row.template).sort()).toEqual([
      'customer.order-paid', 'customer.order-placed', 'customer.shipment-arrived', 'customer.shipment-shipped',
    ]);
    for (const row of rows) {
      // 狀態與 provider 證據都來自 base 通知能力：commerce 不另外記一份可能過時的副本。
      expect(row.status).toBe('sent');
      expect(row.providerRef).toMatch(/^<[0-9a-f]+@storeweave\.mail>$/);
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

  it('保留舊 worker 的 record command，並限制它只能由 system actor 寫入', async () => {
    const product = await createProduct(h.runtime, { priceCents: 4900 });
    await stockUp(h.runtime, product.id, 2);
    const order = await placeOrder(h.runtime, product.id);
    const queued = await h.runtime.commands.execute<{ id: string }>('commerce.notification.queueLifecycleDelivery', {
      eventId: randomUUID(), orderId: order.id, template: 'customer.order-placed', variables: {},
    }, { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() });

    const failed = await h.runtime.commands.execute<{ id: string; status: string; providerRef: string; lastError: string | null }>(
      'commerce.notification.recordLifecycleDelivery',
      { id: queued.id, status: 'failed', providerRef: 'legacy-provider-ref', error: 'legacy provider failure' },
      { actor: SYSTEM_ACTOR, idempotencyKey: randomUUID() },
    );
    expect(failed).toMatchObject({ id: queued.id, status: 'failed', providerRef: 'legacy-provider-ref', lastError: 'legacy provider failure' });
    await expect(h.runtime.commands.execute(
      'commerce.notification.recordLifecycleDelivery',
      { id: queued.id, status: 'sent', providerRef: 'operator-ref' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
    )).rejects.toThrow('Only notification workers may record delivery results');
    await settleWorker(h.worker);
  });

  it('重複 worker drain 不重送同一 event/template', async () => {
    const { order } = await paidOrderWithShipment(h);
    await settleWorker(h.worker);
    const before = (await lifecycleDeliveries(h, order.id)).items;
    const sent = sink.messages.length;
    await settleWorker(h.worker);
    const after = (await lifecycleDeliveries(h, order.id)).items;
    expect(after).toHaveLength(4);
    expect(after.map((row) => [row.eventId, row.template, row.providerRef]).sort())
      .toEqual(before.map((row) => [row.eventId, row.template, row.providerRef]).sort());
    expect(sink.messages.length).toBe(sent);
  });

  it('退信先留下紀錄才進死信，重送是營運的決定；訂單不受影響', async () => {
    const rejecting = await smtpSink({ rejectAll: true });
    const failing = await createHarness({
      extensions: { 'mock-payment': { autoApprove: true }, mcp: {} },
      mail: mailConfig(rejecting.port),
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
      expect(rows[0].lastError).not.toContain('@example.com');
      // 收件人被明確退回是永久性失敗：先寫下證據，再讓工作進死信等營運決定重送，
      // 而不是拿同一個地址無止盡重試。
      const jobs = await failing.runtime.database.db.execute<{ status: string; last_error: string | null }>(sql`
        SELECT status, last_error FROM platform_jobs WHERE type = 'platform.notification.deliver'
      `);
      expect(jobs.rows).toContainEqual(expect.objectContaining({ status: 'dead' }));
      const current = await failing.runtime.queries.execute<any>('commerce.order.getOrder', { id: order.id }, { actor: ADMIN_ACTOR });
      expect(current.status).toBe('pending');
    } finally {
      await failing.close();
    }
  });

  it('沒有設定寄信管道時記成 skipped，不會排出永遠送不出去的工作', async () => {
    const disabled = await createHarness({ extensions: { 'mock-payment': { autoApprove: true }, mcp: {} } });
    try {
      const product = await createProduct(disabled.runtime);
      await stockUp(disabled.runtime, product.id, 2);
      const order = await placeOrder(disabled.runtime, product.id);
      await settleWorker(disabled.worker);

      const rows = (await lifecycleDeliveries(disabled, order.id)).items;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ template: 'customer.order-placed', status: 'skipped' });
      const jobs = await disabled.runtime.database.db.execute(sql`
        SELECT 1 FROM platform_jobs WHERE type = 'platform.notification.deliver'
      `);
      expect(jobs.rows).toHaveLength(0);
    } finally {
      await disabled.close();
    }
  });
});
