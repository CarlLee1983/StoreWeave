import { describe, expect, it } from 'vitest';
import { createTestExtensionContext } from '@storeweave/extension-sdk';
import { createMockPaymentProvider, mockPaymentConfig } from '@storeweave/ext-mock-payment';

function provider(overrides: Record<string, unknown> = {}) {
  const ctx = createTestExtensionContext({
    extensionId: 'mock-payment',
    config: mockPaymentConfig.parse(overrides),
  });
  return { provider: createMockPaymentProvider(ctx), ctx };
}

const payment = {
  orderId: '11111111-1111-4111-8111-111111111111',
  orderNumber: 'SW-1000',
  amountCents: 1000,
  currency: 'TWD',
  method: 'mock',
  reference: 'order:11111111-1111-4111-8111-111111111111',
};

describe('mock payment provider', () => {
  it('公開讓商店在付款前選擇的即時付款方式', () => {
    expect(provider().provider.paymentMethods()).toEqual([
      { code: 'mock', label: 'Mock payment', timing: 'immediate' },
    ]);
  });

  it('成功啟動付款並回傳確認結果', async () => {
    const result = await provider().provider.start(payment);
    expect(result.status).toBe('confirmed');
    expect(result.providerRef).toMatch(/^mock_/);
  });

  it('同一個 reference 重複請求不會產生第二筆收款', async () => {
    const { provider: p } = provider();
    const first = await p.start(payment);
    const second = await p.start(payment);
    expect(second.status).toBe('confirmed');
    if (second.status !== 'confirmed') throw new Error('expected a confirmed payment');
    expect(second.providerRef).toBe(first.providerRef);
    expect(second.message).toBe('replayed');
  });

  it('autoApprove=false 時拒付', async () => {
    const result = await provider({ autoApprove: false }).provider.start(payment);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failed payment');
    expect(result.message).toMatch(/declined/);
  });

  it('超過 declineAboveCents 就拒付', async () => {
    const result = await provider({ declineAboveCents: 500 }).provider.start(payment);
    expect(result.status).toBe('failed');
  });

  it('拒絕未設定的付款方式', async () => {
    const result = await provider().provider.start({ ...payment, method: 'unknown' });
    expect(result).toEqual({ status: 'failed', message: 'unsupported mock payment method: unknown' });
  });

  it('拒付不會留下紀錄，之後仍可成功', async () => {
    const { provider: p, ctx } = provider({ autoApprove: false });
    await p.start(payment);
    expect(await ctx.store.get(`payment:${payment.reference}`)).toBeNull();
  });

  it('以平台退款 reference 去重，並回傳穩定的 provider refund reference', async () => {
    const { provider: p } = provider();
    const refund = { providerRef: 'mock_charge_1', amountCents: 1000, currency: 'TWD', reference: 'refund:1:attempt:1' };
    const first = await p.refund(refund);
    const replay = await p.refund(refund);
    expect(first).toMatchObject({ status: 'succeeded', providerRefundRef: expect.stringMatching(/^mock_refund_/) });
    expect(replay).toEqual({ ...first, message: 'replayed' });
  });

  it('原子解析 callback 並回傳 provider acknowledgement', async () => {
    const p = provider().provider;
    const callback = await p.parseCallback({
      body: new TextEncoder().encode(JSON.stringify({
        type: 'payment_info_issued',
        reference: payment.reference,
        providerRef: 'mock_callback_1',
        instructions: [{ label: 'payment code', value: '123456' }],
        expiresAt: '2026-08-25T00:00:00.000Z',
      })),
      headers: {},
      query: {},
    });
    expect(callback).toMatchObject({ type: 'payment_info_issued', reference: payment.reference });
    expect(p.acknowledgeCallback({ accepted: true })).toEqual({ statusCode: 200, body: 'OK' });
  });
});
