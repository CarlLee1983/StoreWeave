import { describe, expect, it } from 'vitest';
import { createTestExtensionContext } from '@storeweave/extension-sdk';
import { demoErpConfig, demoErpExtension, deliveryKey, type DeliveryRecord } from '@storeweave/ext-demo-erp';

const paidEvent = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'commerce.order.paid.v1',
  version: 1,
  occurredAt: new Date(),
  actorId: 'user:1',
  correlationId: 'corr-1',
  payload: {
    orderId: '22222222-2222-4222-8222-222222222222',
    orderNumber: 'SW-1001',
    customerEmail: 'buyer@example.com',
    currency: 'TWD',
    totalCents: 34_500,
    paidAt: new Date(),
    paymentProvider: 'mock-payment',
    paymentRef: 'mock_abc',
    lines: [
      { productId: '33333333-3333-4333-8333-333333333333', sku: 'TEA-001', name: '高山烏龍', quantity: 3, unitPriceCents: 11_500, lineTotalCents: 34_500 },
    ],
  },
};

async function setup(config: Record<string, unknown> = {}) {
  const ctx = createTestExtensionContext({
    extensionId: 'demo-erp',
    config: demoErpConfig.parse(config),
    secrets: { DEMO_ERP_API_KEY: 'k' },
  });
  const registration = await demoErpExtension.setup(ctx);
  const jobHandlers = Object.fromEntries((registration.jobs ?? []).map((j) => [j.type, j.handler]));
  // provider 由 extension 自己註冊，測試環境把它接回 ctx
  (ctx as any).getProvider = () => registration.providers![0];
  return { ctx, registration, jobHandlers };
}

const orderId = paidEvent.payload.orderId;

describe('demo-erp 投遞流程', () => {
  it('訂閱事件時只排入工作，不直接呼叫 ERP', async () => {
    const { ctx, registration } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    expect(ctx.calls.jobs).toHaveLength(1);
    expect(ctx.calls.jobs[0].dedupeKey).toBe(`ext.demo-erp:push:${orderId}`);
    const record = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    expect(record?.status).toBe('pending');
  });

  it('背景工作成功後記錄 remoteId 與 attempts', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    await ctx.drainJobs(jobHandlers as any);
    const record = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    expect(record?.status).toBe('sent');
    expect(record?.attempts).toBe(1);
    expect(record?.remoteId).toMatch(/^ERP-/);
    expect(record?.lastError).toBeNull();
  });

  it('重複收到同一個事件不會產生第二個工作', async () => {
    const { ctx, registration } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    await registration.events![0].handler(paidEvent as any, ctx);
    expect(ctx.calls.jobs).toHaveLength(2);
    const enqueuedIds = new Set(ctx.calls.jobs.map((j) => j.dedupeKey));
    expect(enqueuedIds.size).toBe(1);
  });

  it('已送出的訂單再收到事件會直接略過', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    await ctx.drainJobs(jobHandlers as any);
    ctx.calls.jobs.length = 0;
    await registration.events![0].handler(paidEvent as any, ctx);
    expect(ctx.calls.jobs).toHaveLength(0);
  });

  it('暫時性失敗會記錄 lastError 並往外拋讓佇列重試', async () => {
    const { ctx, registration, jobHandlers } = await setup({ simulateTransientFailures: 2 });
    await registration.events![0].handler(paidEvent as any, ctx);
    const push = jobHandlers['ext.demo-erp.push-order'];

    await expect(push({ orderId }, { ...ctx, attempt: 1, jobId: 'job-1' } as any)).rejects.toThrow(/simulated transient/);
    let record = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    expect(record?.status).toBe('failed');
    expect(record?.attempts).toBe(1);
    expect(record?.lastError).toMatch(/simulated transient/);

    await expect(push({ orderId }, { ...ctx, attempt: 2, jobId: 'job-1' } as any)).rejects.toThrow();
    await push({ orderId }, { ...ctx, attempt: 3, jobId: 'job-1' } as any);

    record = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    expect(record?.status).toBe('sent');
    expect(record?.attempts).toBe(3);
    expect(record?.remoteId).toMatch(/^ERP-/);
  });

  it('遠端以 reference 去重：重跑工作不會產生第二張單據', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    const push = jobHandlers['ext.demo-erp.push-order'];
    await push({ orderId }, { ...ctx, attempt: 1, jobId: 'job-1' } as any);
    const first = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));

    // 強制重跑（模擬工作重試時狀態已是 sent）
    await ctx.store.set(deliveryKey(orderId), { ...first!, status: 'failed' });
    await push({ orderId }, { ...ctx, attempt: 2, jobId: 'job-1' } as any);
    const second = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    expect(second?.remoteId).toBe(first?.remoteId);
  });

  it('人工重送會重新排入既有工作並累計 manualResends', async () => {
    const { ctx, registration } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    const resend = registration.commands![0].handler;
    const result = await resend({ orderId }, ctx as any);
    expect(result.jobId).toBe('job-1');
    const record = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    expect(record?.manualResends).toBe(1);
  });

  it('已送達訂單的人工重送會重新呼叫 ERP', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    const before = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    await ctx.store.set(deliveryKey(orderId), { ...before!, status: 'sent', remoteId: 'already-sent' });

    await registration.commands![0].handler({ orderId }, ctx as any);
    const queued = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    expect(queued?.status).toBe('pending');
    await ctx.drainJobs(jobHandlers as any);

    const after = await ctx.store.get<DeliveryRecord>(deliveryKey(orderId));
    expect(after).toMatchObject({ status: 'sent', manualResends: 1 });
    expect(after?.remoteId).not.toBe('already-sent');
    expect(after?.attempts).toBe((before?.attempts ?? 0) + 1);
  });

  it('對不存在的訂單重送會回 NOT_FOUND', async () => {
    const { ctx, registration } = await setup();
    const resend = registration.commands![0].handler;
    await expect(resend({ orderId: '99999999-9999-4999-8999-999999999999' }, ctx as any)).rejects.toThrow(/not found/i);
  });

  it('listDeliveries 只回傳自己的紀錄', async () => {
    const { ctx, registration, jobHandlers } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    await ctx.drainJobs(jobHandlers as any);
    const list = await registration.queries![0].handler({ limit: 50 }, ctx as any);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].orderNumber).toBe('SW-1001');
  });

  it('payload inspector 回傳下一次重送會使用的 HTTP ERP body，且不洩漏 API key', async () => {
    const { ctx, registration } = await setup();
    await registration.events![0].handler(paidEvent as any, ctx);
    const inspect = registration.queries!.find((query) => query.descriptor.name === 'ext.demo-erp.inspectDeliveryPayload')!.handler;

    const result = await inspect({ orderId }, ctx as any);

    expect(result).toMatchObject({
      orderId,
      payload: {
        documentType: 'SALES_ORDER',
        reference: 'SO-SW-1001',
        CustomerRef: 'buyer@example.com',
        PaymentRef: 'mock_abc',
      },
    });
    expect(JSON.stringify(result)).not.toContain('DEMO_ERP_API_KEY');
    expect(JSON.stringify(result)).not.toContain('"k"');
  });

  it('payload inspector 對沒有快照的訂單回 NOT_FOUND', async () => {
    const { ctx, registration } = await setup();
    const inspect = registration.queries!.find((query) => query.descriptor.name === 'ext.demo-erp.inspectDeliveryPayload')!.handler;

    await expect(inspect({ orderId: '99999999-9999-4999-8999-999999999999' }, ctx as any)).rejects.toThrow(/not found/i);
  });
});
