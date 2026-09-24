import { describe, expect, it } from 'vitest';
import {
  createTestExtensionContext,
  runPaymentProviderContractChecks,
} from '@storeweave/extension-sdk';
import type { PaymentInitiationInput, PaymentRefundInputV2 } from '@storeweave/extension-sdk';
import { createMockPaymentProvider, mockPaymentConfig } from '@storeweave/ext-mock-payment';

function provider(overrides: Record<string, unknown> = {}) {
  const ctx = createTestExtensionContext({
    extensionId: 'mock-payment',
    config: mockPaymentConfig.parse(overrides),
    declaredSecrets: [],
  });
  return { provider: createMockPaymentProvider(ctx), ctx };
}

const initiation = {
  reference: 'payment:attempt-1',
  displayReference: 'SW-1001',
  amount: 10_000,
  currency: 'TWD',
  method: 'mock',
} satisfies PaymentInitiationInput;

const changedReferenceInputs = [
  { field: 'displayReference', input: { ...initiation, displayReference: 'SW-1001-CHANGED' } },
  { field: 'amount', input: { ...initiation, amount: initiation.amount + 1 } },
  { field: 'currency', input: { ...initiation, currency: 'USD' } },
  { field: 'method', input: { ...initiation, method: 'unconfigured' } },
] as const;

interface StoredPayment {
  readonly status: 'confirmed';
  readonly refunds?: readonly { readonly result: { readonly status: string } }[];
}

async function createdPaymentCount(ctx: ReturnType<typeof provider>['ctx']): Promise<number> {
  const entries = await ctx.store.list<StoredPayment>('payment:', 100);
  return entries.filter(({ value }) => value.status === 'confirmed').length;
}

async function createdRefundCount(ctx: ReturnType<typeof provider>['ctx']): Promise<number> {
  const entries = await ctx.store.list<StoredPayment>('payment:', 100);
  return entries.reduce((count, { value }) => count + (value.refunds?.filter((refund) => refund.result.status === 'succeeded').length ?? 0), 0);
}

function callback(reference: string, providerRef: string) {
  return {
    body: new TextEncoder().encode(JSON.stringify({
      type: 'payment_info_issued',
      reference,
      providerRef,
      instructions: [{ label: 'payment code', value: '123456' }],
      expiresAt: '2026-08-25T00:00:00.000Z',
    })),
    headers: {},
    query: {},
  };
}

function refundInput(providerRef: string, reference: string, amount = 5000): PaymentRefundInputV2 {
  return { providerRef, amount, currency: 'TWD', reference };
}

describe('mock payment provider', () => {
  it('公開讓商店在付款前選擇的即時付款方式', () => {
    expect(provider().provider.paymentMethods()).toEqual([
      { code: 'mock', label: 'Mock payment', timing: 'immediate' },
    ]);
  });

  it('exposes no legacy start method and initiates a neutral payment', async () => {
    const current = provider().provider;
    expect('start' in current).toBe(false);
    const result = await current.initiate(initiation);
    expect(result.status).toBe('confirmed');
    expect(result.providerRef).toMatch(/^mock_/);
  });

  it('同一個 reference 重複請求不會產生第二筆收款', async () => {
    const { provider: p } = provider();
    const first = await p.initiate(initiation);
    const second = await p.initiate(initiation);
    expect(second).toEqual(first);
  });

  it('共享付款帳本並以 V2 reference 對不同事實回傳衝突', async () => {
    const { provider: p, ctx } = provider();
    const first = await p.initiate(initiation);
    const replay = await p.initiate(initiation);
    expect(replay).toEqual(first);

    const conflict = await p.initiate({ ...initiation, amount: initiation.amount + 1 });
    expect(conflict).toMatchObject({ status: 'failed', reason: 'reference_conflict' });
    expect(await createdPaymentCount(ctx)).toBe(1);
  });

  it('拒絕新 reference 使用未設定的付款方式', async () => {
    const { provider: p, ctx } = provider();
    const result = await p.initiate({ ...initiation, reference: 'payment:unsupported-method', method: 'unknown' });
    expect(result).toMatchObject({ status: 'failed', reason: 'provider_rejected' });
    expect(await ctx.store.get('payment:payment:unsupported-method')).toBeNull();
  });

  it('autoApprove=false 時拒付', async () => {
    const result = await provider({ autoApprove: false }).provider.initiate(initiation);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failed payment');
    expect(result.message).toMatch(/declined/);
  });

  it('超過 declineAboveCents 就拒付', async () => {
    const result = await provider({ declineAboveCents: 500 }).provider.initiate(initiation);
    expect(result.status).toBe('failed');
  });

  it('拒絕未設定的付款方式', async () => {
    const result = await provider().provider.initiate({ ...initiation, method: 'unknown' });
    expect(result).toMatchObject({ status: 'failed', reason: 'provider_rejected', message: 'unsupported mock payment method: unknown' });
  });

  it('拒付不會留下紀錄，之後仍可成功', async () => {
    const { provider: p, ctx } = provider({ autoApprove: false });
    await p.initiate(initiation);
    expect(await ctx.store.get(`payment:${initiation.reference}`)).toBeNull();
  });

  it('refund retries replay the same neutral result and keep the historical refund record', async () => {
    const { provider: p, ctx } = provider();
    const started = await p.initiate(initiation);
    if (started.status !== 'confirmed') throw new Error('expected a confirmed payment');
    const refund = refundInput(started.providerRef, 'refund:1:attempt:1', 1_000);
    const first = await p.refund(refund);
    const replay = await p.refund(refund);
    expect(first).toMatchObject({ status: 'succeeded', providerRefundRef: expect.stringMatching(/^mock_refund_/) });
    expect(replay).toEqual(first);
    expect(await ctx.store.get(`refund:${refund.reference}`)).toMatchObject({
      providerRefundRef: expect.stringMatching(/^mock_refund_/),
      providerRef: started.providerRef,
      amountCents: refund.amount,
      currency: 'TWD',
    });
  });

  it('未知付款、超額、幣別不符或重用不同退款事實都不會成功', async () => {
    const { provider: p, ctx } = provider();
    const started = await p.initiate(initiation);
    if (started.status !== 'confirmed') throw new Error('expected a confirmed payment');

    await expect(p.refund(refundInput('unknown-provider-ref', 'refund:unknown', 100)))
      .resolves.toMatchObject({ status: 'rejected' });
    await expect(p.refund(refundInput(started.providerRef, 'refund:too-large', 10_001)))
      .resolves.toMatchObject({ status: 'rejected' });
    expect(await ctx.store.get('refund:refund:too-large')).toBeNull();
    expect(await ctx.store.get('refundV2:refund:too-large')).toMatchObject({ status: 'rejected' });
    await expect(p.refund({ ...refundInput(started.providerRef, 'refund:wrong-currency', 100), currency: 'USD' }))
      .resolves.toMatchObject({ status: 'rejected' });

    const valid = refundInput(started.providerRef, 'refund:immutable', 500);
    await expect(p.refund(valid)).resolves.toMatchObject({ status: 'succeeded' });
    await expect(p.refund({ ...valid, amount: 400 })).resolves.toMatchObject({ status: 'rejected' });
    await expect(p.refund(refundInput(started.providerRef, 'refund:second', 500)))
      .resolves.toMatchObject({ status: 'rejected' });
    expect(await ctx.store.get('refund:refund:second')).toBeNull();

    await ctx.store.set('refund:legacy-record', {
      providerRef: started.providerRef,
      amountCents: 100,
      currency: 'TWD',
      providerRefundRef: 'old-version-refund',
    });
    await expect(p.refund(refundInput(started.providerRef, 'legacy-record', 100)))
      .resolves.toEqual({ status: 'succeeded', providerRefundRef: 'old-version-refund' });
    await expect(p.refund(refundInput(started.providerRef, 'legacy-record', 101)))
      .resolves.toMatchObject({ status: 'rejected' });

    await ctx.store.set('payment:legacy-charge', {
      providerRef: 'legacy-provider-ref',
      amountCents: 1000,
      status: 'confirmed',
      chargedAt: '2026-08-25T00:00:00.000Z',
    });
    await ctx.store.set('paymentByProviderRef:legacy-provider-ref', 'legacy-charge');
    await expect(p.refund(refundInput('legacy-provider-ref', 'refund:legacy-charge', 100)))
      .resolves.toMatchObject({ status: 'rejected', message: 'payment is unavailable for a domain-neutral refund' });
    await expect(p.refund(refundInput('legacy-provider-ref', 'refund:legacy-charge-too-large', 1001)))
      .resolves.toMatchObject({ status: 'rejected' });
  });

  it('passes the shared initiation, replay, reference-conflict, and refund contract', async () => {
    const { provider: p, ctx } = provider();
    const started = await p.initiate(initiation);
    if (started.status !== 'confirmed') throw new Error('expected a confirmed payment');
    const checks = await runPaymentProviderContractChecks(p, {
      initiation,
      expectedInitiationStatus: 'confirmed',
      changedReferenceInputs,
      refunds: [{ name: 'supported', input: refundInput(started.providerRef, 'refund:shared-success'), expectedStatus: 'succeeded' }],
      createdPaymentCount: () => createdPaymentCount(ctx),
      createdRefundCount: () => createdRefundCount(ctx),
    });

    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(await createdPaymentCount(ctx)).toBe(1);
    expect(await createdRefundCount(ctx)).toBe(1);
  });

  it('serializes concurrent identical initiations and refund retries', async () => {
    const { provider: p, ctx } = provider();
    const [first, second] = await Promise.all([p.initiate(initiation), p.initiate(initiation)]);
    expect(first).toMatchObject({ status: 'confirmed' });
    expect(second).toEqual(first);
    if (first.status !== 'confirmed') throw new Error('expected a confirmed payment');
    expect(await createdPaymentCount(ctx)).toBe(1);

    const refund = refundInput(first.providerRef, 'refund:concurrent');
    const [refundFirst, refundSecond] = await Promise.all([p.refund(refund), p.refund(refund)]);
    expect(refundFirst).toMatchObject({ status: 'succeeded' });
    expect(refundSecond).toEqual(refundFirst);
    expect(await createdRefundCount(ctx)).toBe(1);
  });

  it('以唯一 provider reference 驗證 callback，拒絕未知或不匹配的付款', async () => {
    const { provider: p, ctx } = provider();
    const started = await p.initiate(initiation);
    if (started.status !== 'confirmed') throw new Error('expected a confirmed payment');

    const parsed = await p.parseCallback(callback(initiation.reference, started.providerRef));
    expect(parsed).toMatchObject({ type: 'payment_info_issued', reference: initiation.reference, providerRef: started.providerRef });
    expect(p.acknowledgeCallback({ accepted: true })).toEqual({ statusCode: 200, body: 'OK' });
    await expect(p.parseCallback(callback('payment:unknown', started.providerRef))).rejects.toThrow(/unknown payment/);
    await expect(p.parseCallback(callback(initiation.reference, 'wrong-provider-ref'))).rejects.toThrow(/does not match/);

    const legacyReference = 'payment:legacy-attempt';
    const legacyProviderRef = 'legacy-provider-ref';
    await ctx.store.set(`payment:${legacyReference}`, {
      providerRef: legacyProviderRef,
      amountCents: 1000,
      status: 'confirmed',
      chargedAt: '2026-08-25T00:00:00.000Z',
    });
    await expect(p.parseCallback(callback(legacyReference, legacyProviderRef)))
      .resolves.toMatchObject({ type: 'payment_info_issued', reference: legacyReference, providerRef: legacyProviderRef });
  });
});
