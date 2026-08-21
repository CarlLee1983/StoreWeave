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

const charge = {
  orderId: '11111111-1111-4111-8111-111111111111',
  orderNumber: 'SW-1000',
  amountCents: 1000,
  currency: 'TWD',
  reference: 'order:11111111-1111-4111-8111-111111111111',
};

describe('mock payment provider', () => {
  it('成功收款並回傳 providerRef', async () => {
    const result = await provider().provider.charge(charge);
    expect(result.status).toBe('succeeded');
    expect(result.providerRef).toMatch(/^mock_/);
  });

  it('同一個 reference 重複請求不會產生第二筆收款', async () => {
    const { provider: p } = provider();
    const first = await p.charge(charge);
    const second = await p.charge(charge);
    expect(second.providerRef).toBe(first.providerRef);
    expect(second.message).toBe('replayed');
  });

  it('autoApprove=false 時拒付', async () => {
    const result = await provider({ autoApprove: false }).provider.charge(charge);
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/declined/);
  });

  it('超過 declineAboveCents 就拒付', async () => {
    const result = await provider({ declineAboveCents: 500 }).provider.charge(charge);
    expect(result.status).toBe('failed');
  });

  it('拒付不會留下紀錄，之後仍可成功', async () => {
    const { provider: p, ctx } = provider({ autoApprove: false });
    await p.charge(charge);
    expect(await ctx.store.get(`charge:${charge.reference}`)).toBeNull();
  });
});
