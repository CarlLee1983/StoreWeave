import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ADMIN_ACTOR, createHarness, createProduct, payOrder, placeOrder, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

async function outboxFor(orderId: string) {
  const rows = await h.runtime.database.db.execute<{ event_name: string; status: string }>(sql`
    SELECT event_name, status FROM platform_outbox WHERE payload->>'orderId' = ${orderId} ORDER BY occurred_at
  `);
  return rows.rows;
}

describe('流程二：訂單、付款與 Transactional Outbox', () => {
  it('下單會扣庫存並產生 commerce.order.placed.v1', async () => {
    const product = await createProduct(h.runtime, { priceCents: 2500 });
    await stockUp(h.runtime, product.id, 10);
    const order = await placeOrder(h.runtime, product.id, 3);

    expect(order.status).toBe('pending');
    expect(order.totalCents).toBe(7500);
    const stock = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(stock.onHand).toBe(7);
    expect((await outboxFor(order.id)).map((r) => r.event_name)).toEqual(['commerce.order.placed.v1']);
  });

  it('庫存不足時整筆訂單回滾，不留下訂單也不動庫存', async () => {
    const product = await createProduct(h.runtime);
    await stockUp(h.runtime, product.id, 2);
    await expect(placeOrder(h.runtime, product.id, 5)).rejects.toThrow(/Insufficient stock/);

    const stock = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(stock.onHand).toBe(2);
    const orders = await h.runtime.queries.execute<any>('commerce.order.listOrders', {}, { actor: ADMIN_ACTOR });
    expect(orders.items.every((o: any) => o.lines.every((l: any) => l.productId !== product.id))).toBe(true);
  });

  it('付款成功時，訂單狀態與 commerce.order.paid.v1 寫在同一個交易', async () => {
    const product = await createProduct(h.runtime, { priceCents: 1200 });
    await stockUp(h.runtime, product.id, 5);
    const order = await placeOrder(h.runtime, product.id, 2);
    const paid = await payOrder(h.runtime, order.id);

    expect(paid.status).toBe('paid');
    const events = await outboxFor(order.id);
    expect(events.map((e) => e.event_name)).toEqual(['commerce.order.placed.v1', 'commerce.order.paid.v1']);
    expect(events.every((e) => e.status === 'pending')).toBe(true);

    const payload = await h.runtime.database.db.execute<{ payload: any }>(sql`
      SELECT payload FROM platform_outbox WHERE event_name = 'commerce.order.paid.v1' AND payload->>'orderId' = ${order.id}
    `);
    expect(payload.rows[0].payload.paymentProvider).toBe('mock-payment');
    expect(payload.rows[0].payload.totalCents).toBe(2400);
    expect(payload.rows[0].payload.lines).toHaveLength(1);
  });

  it('付款失敗時訂單維持 pending，且不會有 paid 事件', async () => {
    const failing = await createHarness({ extensions: { 'mock-payment': { autoApprove: false }, 'demo-erp': { endpoint: 'mock://x' }, mcp: {} } });
    try {
      const product = await createProduct(failing.runtime, { priceCents: 500 });
      await stockUp(failing.runtime, product.id, 5);
      const order = await placeOrder(failing.runtime, product.id, 1);
      await expect(payOrder(failing.runtime, order.id)).rejects.toThrow(/Payment failed/);

      const fetched = await failing.runtime.queries.execute<any>('commerce.order.getOrder', { id: order.id }, { actor: ADMIN_ACTOR });
      expect(fetched.status).toBe('pending');

      const events = await failing.runtime.database.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM platform_outbox WHERE event_name = 'commerce.order.paid.v1'
      `);
      expect(Number(events.rows[0].count)).toBe(0);
    } finally {
      await failing.close();
    }
  }, 120_000);

  it('重複付款是冪等的，不會產生第二筆收款或第二個事件', async () => {
    const product = await createProduct(h.runtime, { priceCents: 999 });
    await stockUp(h.runtime, product.id, 5);
    const order = await placeOrder(h.runtime, product.id, 1);
    const key = randomUUID();

    await h.runtime.commands.execute('commerce.order.payOrder', { orderId: order.id }, { actor: ADMIN_ACTOR, idempotencyKey: key });
    await h.runtime.commands.execute('commerce.order.payOrder', { orderId: order.id }, { actor: ADMIN_ACTOR, idempotencyKey: key });
    // 換一把新的 key 也不能重複收款
    await h.runtime.commands.execute('commerce.order.payOrder', { orderId: order.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const payments = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM order_payments WHERE order_id = ${order.id}
    `);
    expect(Number(payments.rows[0].count)).toBe(1);
    const paidEvents = (await outboxFor(order.id)).filter((e) => e.event_name === 'commerce.order.paid.v1');
    expect(paidEvents).toHaveLength(1);
  });

  it('取消訂單會回補庫存並發出 commerce.order.cancelled.v1', async () => {
    const product = await createProduct(h.runtime);
    await stockUp(h.runtime, product.id, 4);
    const order = await placeOrder(h.runtime, product.id, 3);
    await h.runtime.commands.execute('commerce.order.cancelOrder', { orderId: order.id, reason: 'test' },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });

    const stock = await h.runtime.queries.execute<any>('commerce.inventory.getStock', { productId: product.id }, { actor: ADMIN_ACTOR });
    expect(stock.onHand).toBe(4);
    expect((await outboxFor(order.id)).map((e) => e.event_name)).toContain('commerce.order.cancelled.v1');
  });

  it('已付款的訂單不能取消', async () => {
    const product = await createProduct(h.runtime);
    await stockUp(h.runtime, product.id, 2);
    const order = await placeOrder(h.runtime, product.id, 1);
    await payOrder(h.runtime, order.id);
    await expect(
      h.runtime.commands.execute('commerce.order.cancelOrder', { orderId: order.id, reason: 'x' },
        { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/cannot be cancelled/);
  });

  it('銷售摘要只計入已付款訂單', async () => {
    const isolated = await createHarness();
    try {
      const product = await createProduct(isolated.runtime, { priceCents: 10_000 });
      await stockUp(isolated.runtime, product.id, 10);
      const paid = await placeOrder(isolated.runtime, product.id, 2);
      await payOrder(isolated.runtime, paid.id);
      await placeOrder(isolated.runtime, product.id, 1);

      const summary = await isolated.runtime.queries.execute<any>('commerce.order.salesSummary', {}, { actor: ADMIN_ACTOR });
      expect(summary.paidOrderCount).toBe(1);
      expect(summary.pendingOrderCount).toBe(1);
      expect(summary.grossRevenueCents).toBe(20_000);
      expect(summary.topProducts[0].quantity).toBe(2);
    } finally {
      await isolated.close();
    }
  }, 120_000);
});
