import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ADMIN_ACTOR, createHarness, createProduct, payOrder, placeOrder, stockUp, type TestHarness } from './helpers';

let h: TestHarness;
beforeAll(async () => { h = await createHarness(); }, 300_000);
afterAll(async () => { await h?.close(); });

async function deliveries(harness: TestHarness) {
  return harness.runtime.queries.execute<{ items: any[] }>(
    'ext.demo-erp.listDeliveries', { limit: 100 }, { actor: ADMIN_ACTOR },
  );
}

async function paidOrder(harness: TestHarness) {
  const product = await createProduct(harness.runtime, { priceCents: 4900 });
  await stockUp(harness.runtime, product.id, 10);
  const order = await placeOrder(harness.runtime, product.id, 2);
  await payOrder(harness.runtime, order.id);
  await harness.worker.runJobs();
  return order;
}

describe('流程三：Outbox → Worker → Demo ERP Extension', () => {
  it('worker 把 outbox 事件轉成每個訂閱者一筆的投遞工作', async () => {
    const order = await paidOrder(h);
    const result = await h.worker.tick();
    expect(result.relayed).toBeGreaterThan(0);

    const jobs = await h.runtime.database.db.execute<{ dedupe_key: string; type: string }>(sql`
      SELECT dedupe_key, type FROM platform_jobs WHERE type = 'ext.demo-erp.push-order'
    `);
    expect(jobs.rows.length).toBeGreaterThan(0);
    expect(jobs.rows[0].dedupe_key).toContain(order.id);
  });

  it('drain 之後 ERP 投遞成功並記錄 remoteId', async () => {
    const order = await paidOrder(h);
    await h.worker.drain();
    const record = (await deliveries(h)).items.find((d) => d.orderId === order.id);
    expect(record?.status).toBe('sent');
    expect(record?.attempts).toBe(1);
    expect(record?.remoteId).toMatch(/^ERP-/);
    expect(record?.lastError).toBeNull();
  });

  it('重複 drain 不會重複送到 ERP', async () => {
    const order = await paidOrder(h);
    await h.worker.drain();
    const before = (await deliveries(h)).items.find((d) => d.orderId === order.id);
    await h.worker.drain();
    await h.worker.drain();
    const after = (await deliveries(h)).items.find((d) => d.orderId === order.id);
    expect(after?.remoteId).toBe(before?.remoteId);
    expect(after?.attempts).toBe(before?.attempts);
  });

  it('outbox 事件全部處理完後標記為 relayed', async () => {
    await paidOrder(h);
    await h.worker.drain();
    const pending = await h.runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_outbox WHERE status = 'pending'
    `);
    expect(Number(pending.rows[0].count)).toBe(0);
  });

  it('ERP 暫時失敗會重試，成功後只有一張遠端單據', async () => {
    const flaky = await createHarness({
      extensions: {
        'mock-payment': { autoApprove: true },
        'demo-erp': { endpoint: 'mock://demo-erp', simulateTransientFailures: 2, maxAttempts: 8 },
        mcp: {},
      },
    });
    try {
      const order = await paidOrder(flaky);
      const seen: string[] = [];
      let record: any;
      for (let i = 0; i < 10; i += 1) {
        // 縮短退避等待，讓測試不必真的睡 2/4/8 秒
        await flaky.runtime.database.db.execute(sql`UPDATE platform_jobs SET run_at = now() WHERE status = 'pending'`);
        await flaky.worker.tick();
        record = (await deliveries(flaky)).items.find((d) => d.orderId === order.id);
        if (record) seen.push(record.status);
        if (record?.status === 'sent') break;
      }

      // 前兩次推送被模擬成暫時性失敗，第三次成功
      expect(seen).toContain('failed');
      expect(record?.status).toBe('sent');
      expect(record?.attempts).toBe(3);
      expect(record?.lastError).toBeNull();
      expect(record?.remoteId).toMatch(/^ERP-/);

      const jobs = await flaky.runtime.database.db.execute<{ attempts: number; status: string }>(sql`
        SELECT attempts, status FROM platform_jobs WHERE type = 'ext.demo-erp.push-order'
      `);
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].status).toBe('completed');
    } finally {
      await flaky.close();
    }
  }, 180_000);

  it('人工重送 command 會重新排入既有工作，遠端仍然只有一張單據', async () => {
    const order = await paidOrder(h);
    await h.worker.drain();
    const before = (await deliveries(h)).items.find((d) => d.orderId === order.id);

    const result = await h.runtime.commands.execute<{ jobId: string | null }>(
      'ext.demo-erp.resendOrder', { orderId: order.id }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
    );
    expect(result.jobId).toBe(before?.jobId);

    await h.worker.drain();
    const after = (await deliveries(h)).items.find((d) => d.orderId === order.id);
    expect(after?.manualResends).toBe(1);
    expect(after?.remoteId).toBe(before?.remoteId);
  });

  it('Extension 只能操作自己宣告過權限的 Command', async () => {
    const ext = h.runtime.extensions.find('demo-erp');
    expect(ext).toBeDefined();
    await expect(
      ext!.context.commands.execute('commerce.catalog.createProduct',
        { sku: 'ERP-HACK', name: 'x', priceCents: 1, currency: 'TWD' }, { idempotencyKey: randomUUID() }),
    ).rejects.toThrow(/Forbidden/);
  });

  it('Extension 拿不到資料庫連線或交易物件', () => {
    const ext = h.runtime.extensions.find('demo-erp')!;
    expect(Object.keys(ext.context)).not.toContain('tx');
    expect(Object.keys(ext.context)).not.toContain('db');
    expect(Object.keys(ext.context)).not.toContain('database');
    expect((ext.context as unknown as Record<string, unknown>).database).toBeUndefined();
  });

  it('Extension 的資料以 extension id 隔離', async () => {
    const erp = h.runtime.extensions.find('demo-erp')!;
    const payment = h.runtime.extensions.find('mock-payment')!;
    await erp.context.store.set('isolation-probe', { from: 'erp' });
    expect(await payment.context.store.get('isolation-probe')).toBeNull();
    expect(await erp.context.store.get('isolation-probe')).toEqual({ from: 'erp' });
  });

  it('Extension 只能宣告過的 secret 才讀得到', () => {
    const erp = h.runtime.extensions.find('demo-erp')!;
    expect(erp.context.secret('DEMO_ERP_API_KEY')).toBe('test-key');
    expect(() => erp.context.secret('COMMERCE_ADMIN_TOKEN')).toThrow(/must declare secret/);
  });
});
