import { describe, expect, it, vi } from 'vitest';
import type {
  PaymentInitiationInput,
  PaymentInitiationResult,
  PaymentMethod,
  ProviderRegistry,
} from '@storeweave/extension-sdk';
import { createProcessPaymentJob, type OrderModuleDeps } from '../src/commands';

const orderId = '11111111-1111-4111-8111-111111111111';
const attemptRef = 'payment:attempt-1';
const payload = {
  orderId,
  orderNumber: 'SW-1000',
  amountCents: 1000,
  currency: 'TWD',
  provider: 'test-payment',
  method: 'card',
  attemptRef,
};

type TestOrderPaymentProvider = {
  readonly id: string;
  readonly kind: 'payment';
  paymentMethods(): readonly PaymentMethod[];
  initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult>;
};

function makeProvider(result: PaymentInitiationResult) {
  const initiate = vi.fn(async (_input: PaymentInitiationInput) => result);
  const paymentProvider: TestOrderPaymentProvider = {
    id: 'test-payment',
    kind: 'payment',
    paymentMethods: () => [{ code: 'card', label: 'Card', timing: 'immediate' }],
    initiate,
  };
  const providers = {
    get: vi.fn((_kind: string, _id?: string) => paymentProvider),
  } as unknown as ProviderRegistry;
  const deps: OrderModuleDeps = { providers, defaultCurrency: 'TWD', orderNumberPrefix: 'SW' };
  return { initiate, provider: paymentProvider, job: createProcessPaymentJob(deps) };
}

function jobContext(overrides: { status?: string; attemptStatus?: string; expiresAt?: string | null } = {}) {
  const executeQuery = vi.fn(async () => ({
    status: overrides.status ?? 'payment_processing',
    expiresAt: overrides.expiresAt ?? '2099-01-01T00:00:00.000Z',
    paymentAttempts: [{ attemptRef, status: overrides.attemptStatus ?? 'created' }],
  }));
  const executeCommand = vi.fn(async (_name: string, _input: unknown, _idempotencyKey: string) => ({}));
  return { executeQuery, executeCommand, context: { executeQuery, executeCommand } };
}

describe('Order payment job Provider ABI migration', () => {
  it('sends only neutral payment facts and maps each V2 result to the existing Order result contract', async () => {
    const cases: {
      result: PaymentInitiationResult;
      expected: Record<string, unknown>;
      suffix: string;
    }[] = [
      { result: { status: 'confirmed', providerRef: 'trade-1' }, expected: { status: 'confirmed', providerRef: 'trade-1' }, suffix: 'confirmed:trade-1' },
      {
        result: { status: 'redirect', providerRef: 'trade-2', action: { type: 'form_post', url: 'https://pay.example.test', fields: { token: 'signed' } } },
        expected: { status: 'redirect', providerRef: 'trade-2', action: { type: 'form_post', url: 'https://pay.example.test', fields: { token: 'signed' } } },
        suffix: 'redirect:trade-2',
      },
      {
        result: { status: 'awaiting_payment', providerRef: 'trade-3', instructions: [{ label: 'ATM code', value: '1234' }], expiresAt: '2099-02-01T00:00:00.000Z' },
        expected: { status: 'awaiting_payment', providerRef: 'trade-3', instructions: [{ label: 'ATM code', value: '1234' }], expiresAt: new Date('2099-02-01T00:00:00.000Z') },
        suffix: 'awaiting_payment:trade-3',
      },
      {
        result: { status: 'failed', reason: 'provider_rejected', providerRef: 'trade-4', message: 'declined' },
        expected: { status: 'failed', providerRef: 'trade-4', message: 'declined' },
        suffix: 'failed:trade-4',
      },
      {
        result: { status: 'failed', reason: 'reference_conflict', providerRef: 'trade-5', message: 'reference conflict' },
        expected: { status: 'failed', providerRef: 'trade-5', message: 'reference conflict' },
        suffix: 'failed:trade-5',
      },
    ];

    for (const { result, expected, suffix } of cases) {
      const { initiate, provider, job } = makeProvider(result);
      const ctx = jobContext();
      await job(payload, ctx.context);

      expect(initiate).toHaveBeenCalledWith({
        reference: attemptRef,
        displayReference: 'SW-1000',
        amount: 1000,
        currency: 'TWD',
        method: 'card',
      });
      expect('start' in provider).toBe(false);
      expect(ctx.executeCommand).toHaveBeenCalledWith(
        'commerce.order.recordPaymentResult',
        { attemptRef, provider: 'test-payment', ...expected },
        `payment-result:test-payment:${attemptRef}:${suffix}`,
      );
      expect(ctx.executeCommand.mock.calls[0][1]).not.toHaveProperty('reason');
    }
  });

  it('does not call the provider for terminal Orders or completed attempts', async () => {
    for (const overrides of [
      { status: 'paid' },
      { status: 'expired' },
      { status: 'cancelled' },
      { status: 'payment_processing', attemptStatus: 'failed' },
    ]) {
      const { initiate, job } = makeProvider({ status: 'confirmed', providerRef: 'unused' });
      const ctx = jobContext(overrides);
      await job(payload, ctx.context);
      expect(initiate).not.toHaveBeenCalled();
      expect(ctx.executeCommand).not.toHaveBeenCalled();
    }
  });

  it('rejects a start-only provider without a legacy fallback', async () => {
    const start = vi.fn();
    const providers = {
      get: vi.fn(() => ({ id: 'legacy-only', kind: 'payment', paymentMethods: () => [], start })),
    } as unknown as ProviderRegistry;
    const job = createProcessPaymentJob({ providers, defaultCurrency: 'TWD', orderNumberPrefix: 'SW' });
    const ctx = jobContext();

    await expect(job(payload, ctx.context)).rejects.toThrow('does not support neutral initiation');
    expect(start).not.toHaveBeenCalled();
  });

  it('requests Order expiry for a stale payment attempt without calling the provider', async () => {
    const { initiate, job } = makeProvider({ status: 'confirmed', providerRef: 'unused' });
    const ctx = jobContext({ expiresAt: '2000-01-01T00:00:00.000Z' });
    await job(payload, ctx.context);

    expect(initiate).not.toHaveBeenCalled();
    expect(ctx.executeCommand).toHaveBeenCalledWith(
      'commerce.order.expireOrder',
      { orderId },
      `expire-order:${orderId}:${new Date('2000-01-01T00:00:00.000Z').getTime()}`,
    );
  });
});
