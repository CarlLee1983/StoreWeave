import { describe, expect, it } from 'vitest';
import type {
  AnyProvider,
  PaymentInitiationInput,
  PaymentInitiationResult,
  PaymentProvider,
  PaymentProviderV2,
  PaymentRefundInputV2,
  PaymentRefundResult,
} from '../src/providers';
import { ProviderRegistry } from '../src/providers';
import type { ExtensionRegistration } from '../src/registration';
import {
  PAYMENT_PROVIDER_CONTRACT_V2,
  paymentInitiationInputSchema,
  paymentInitiationResultSchema,
  paymentReferenceConflictResultSchema,
  paymentRefundInputSchema,
  paymentRefundResultSchema,
  runPaymentProviderContractChecks,
} from '../src/payment-contract';

const initiation = {
  reference: 'payment:attempt-1',
  displayReference: 'SW-1000',
  amount: 10_000,
  currency: 'TWD',
  method: 'card',
} satisfies PaymentInitiationInput;

type Assert<T extends true> = T;
const v2DoesNotExposeLegacyStart: Assert<'start' extends keyof PaymentProviderV2 ? false : true> = true;
const pureV2IsRegistrable: Assert<PaymentProviderV2 extends AnyProvider ? true : false> = true;
const legacyOnlyIsNotRegistrable: Assert<PaymentProvider extends AnyProvider ? false : true> = true;

const v2OnlyProvider: PaymentProviderV2 = {
  id: 'v2-only-payment',
  kind: 'payment',
  paymentMethods: () => [],
  async initiate(input) {
    return { status: 'confirmed', providerRef: input.reference };
  },
  async refund() {
    return { status: 'unsupported', message: 'not enabled' };
  },
  async parseCallback() {
    return { type: 'payment_confirmed', reference: 'payment:1', providerRef: 'provider:1' };
  },
  acknowledgeCallback() {
    return { body: 'OK' };
  },
};

// A transitional provider may retain its extra legacy method, while registration
// only depends on the neutral ABI required by all current consumers.
const transitionalProvider = {
  ...v2OnlyProvider,
  async start() {
    return { status: 'confirmed', providerRef: 'provider:1' };
  },
};
const transitionalProviderIsRegistrable: AnyProvider = transitionalProvider;

function acceptInitiationInput(input: PaymentInitiationInput) {
  return input;
}

function refundInput(reference: string): PaymentRefundInputV2 {
  return { providerRef: 'provider-payment-1', amount: 10_000, currency: 'TWD', reference };
}

const changedReferenceInputs = [
  { field: 'displayReference', input: { ...initiation, displayReference: 'SW-1000-CHANGED' } },
  { field: 'amount', input: { ...initiation, amount: initiation.amount + 1 } },
  { field: 'currency', input: { ...initiation, currency: 'USD' } },
  { field: 'method', input: { ...initiation, method: 'unconfigured' } },
] as const;

function reverseObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectKeys) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)])) as T;
  }
  return value;
}

function fakeProvider(
  refundResults: readonly PaymentRefundResult[],
  initiationResult: PaymentInitiationResult = { status: 'confirmed', providerRef: 'provider-payment-1' },
) {
  const initiated = new Map<string, { input: PaymentInitiationInput; result: PaymentInitiationResult }>();
  const acceptedRefunds = new Map<string, { input: PaymentRefundInputV2; result: PaymentRefundResult }>();
  let successfulPayments = 0;
  let successfulRefunds = 0;
  let refundIndex = 0;

  const provider: Pick<PaymentProviderV2, 'initiate' | 'refund'> = {
    async initiate(input) {
      const previous = initiated.get(input.reference);
      if (previous) {
        if (JSON.stringify(previous.input) === JSON.stringify(input)) return reverseObjectKeys(previous.result);
        return { status: 'failed', reason: 'reference_conflict', message: 'reference is already used for different payment facts' };
      }
      if (input.method !== 'card' || input.currency !== 'TWD') {
        return { status: 'failed', reason: 'provider_rejected', message: 'unsupported method or currency' };
      }
      const result = initiationResult;
      initiated.set(input.reference, { input, result });
      successfulPayments += 1;
      return result;
    },
    async refund(input) {
      const previous = acceptedRefunds.get(input.reference);
      if (previous) {
        if (JSON.stringify(previous.input) === JSON.stringify(input)) return previous.result;
        return { status: 'rejected', message: 'reference is already used for different refund facts' };
      }
      const result = refundResults[refundIndex++] ?? { status: 'unsupported', message: 'not configured' };
      acceptedRefunds.set(input.reference, { input, result });
      if (result.status === 'succeeded') successfulRefunds += 1;
      return result;
    },
  };

  return {
    provider,
    createdPaymentCount: () => successfulPayments,
    createdRefundCount: () => successfulRefunds,
  };
}

describe('domain-neutral Payment Provider contract v2', () => {
  it('accepts the exact reference, display reference, amount, currency, and method input', () => {
    expect(paymentInitiationInputSchema.parse(initiation)).toEqual(initiation);
    expect(acceptInitiationInput(initiation)).toEqual(initiation);
    expect(v2DoesNotExposeLegacyStart).toBe(true);
    expect(pureV2IsRegistrable).toBe(true);
    expect(legacyOnlyIsNotRegistrable).toBe(true);
    expect(transitionalProviderIsRegistrable.kind).toBe('payment');
    expect(PAYMENT_PROVIDER_CONTRACT_V2.referencePolicy.conflictPrecedence)
      .toBe('existing-reference-before-provider-capability-validation');
  });

  it('registers a V2-only provider through ExtensionRegistration and ProviderRegistry', () => {
    const registration: ExtensionRegistration = { providers: [v2OnlyProvider] };
    const registry = new ProviderRegistry();
    for (const provider of registration.providers ?? []) registry.register({ provider, owner: 'v2-extension' });

    expect(registry.get<PaymentProviderV2>('payment', v2OnlyProvider.id)).toBe(v2OnlyProvider);
  });

  it('rejects a legacy-only provider before it enters the runtime registry', () => {
    const registry = new ProviderRegistry();
    const legacyOnlyProvider = {
      id: 'legacy-only-payment',
      kind: 'payment' as const,
      paymentMethods: () => [],
      async start() {
        return { status: 'confirmed' as const, providerRef: 'provider:1' };
      },
      async refund() {
        return { status: 'unsupported' as const, message: 'not enabled' };
      },
      async parseCallback() {
        return { type: 'payment_confirmed' as const, reference: 'payment:1', providerRef: 'provider:1' };
      },
      acknowledgeCallback() {
        return { body: 'OK' };
      },
    };

    // @ts-expect-error Legacy-only payment providers no longer satisfy registration.
    expect(() => registry.register({ provider: legacyOnlyProvider, owner: 'legacy-extension' }))
      .toThrow(/neutral initiate contract/);
  });

  it('rejects Order- and Reservation-shaped input at the type and runtime contract', () => {
    expect(paymentInitiationInputSchema.safeParse({ ...initiation, orderId: 'order-1' }).success).toBe(false);
    expect(paymentInitiationInputSchema.safeParse({ ...initiation, orderNumber: 'SW-1000' }).success).toBe(false);
    expect(paymentInitiationInputSchema.safeParse({ ...initiation, reservationId: 'reservation-1' }).success).toBe(false);

    // @ts-expect-error Product aggregate fields are not part of PaymentInitiationInput.
    acceptInitiationInput({ ...initiation, orderId: 'order-1' });
    // @ts-expect-error Product aggregate fields are not part of PaymentInitiationInput.
    acceptInitiationInput({ ...initiation, reservationId: 'reservation-1' });
  });

  it.each([
    ['missing reference', { ...initiation, reference: '' }],
    ['blank display reference', { ...initiation, displayReference: '   ' }],
    ['overlong reference', { ...initiation, reference: 'r'.repeat(201) }],
    ['zero amount', { ...initiation, amount: 0 }],
    ['negative amount', { ...initiation, amount: -1 }],
    ['fractional amount', { ...initiation, amount: 1.5 }],
    ['unsafe amount', { ...initiation, amount: Number.MAX_SAFE_INTEGER + 1 }],
    ['malformed currency', { ...initiation, currency: 'twd' }],
    ['blank method', { ...initiation, method: ' ' }],
  ])('rejects %s', (_case, input) => {
    expect(paymentInitiationInputSchema.safeParse(input).success).toBe(false);
  });

  it('validates the explicit initiation result and reference-conflict variants', () => {
    expect(paymentInitiationResultSchema.safeParse({ status: 'confirmed', providerRef: 'provider-1' }).success).toBe(true);
    expect(paymentInitiationResultSchema.safeParse({ status: 'failed', reason: 'provider_rejected', message: 'declined' }).success).toBe(true);
    expect(paymentInitiationResultSchema.safeParse({ status: 'failed', message: 'ambiguous failure' }).success).toBe(false);
    expect(paymentReferenceConflictResultSchema.safeParse({ status: 'failed', reason: 'reference_conflict', message: 'changed facts' }).success).toBe(true);
  });

  it('rejects an unsupported method for a new reference', async () => {
    const current = fakeProvider([]);
    await expect(current.provider.initiate({ ...initiation, reference: 'payment:unsupported-method', method: 'unconfigured' }))
      .resolves.toMatchObject({ status: 'failed', reason: 'provider_rejected' });
  });

  it('executes replay, changed-reference, and supported refund checks against a provider fixture', async () => {
    const supported = { status: 'succeeded', providerRefundRef: 'refund-1' } as const;
    const unsupported = { status: 'unsupported', message: 'refund not enabled' } as const;
    const rejected = { status: 'rejected', message: 'refund rejected' } as const;
    const refunds = [
      { name: 'supported', input: refundInput('refund:success'), expectedStatus: 'succeeded' as const },
      { name: 'unsupported', input: refundInput('refund:unsupported'), expectedStatus: 'unsupported' as const },
      { name: 'rejected', input: refundInput('refund:rejected'), expectedStatus: 'rejected' as const },
    ];
    const reorderedReplayResult = {
      status: 'redirect',
      providerRef: 'provider-payment-redirect',
      action: {
        type: 'form_post',
        url: 'https://payments.example.test/checkout',
        fields: { MerchantID: 'merchant-1', token: 'token-1' },
      },
    } as const;
    const current = fakeProvider([supported, unsupported, rejected], reorderedReplayResult);
    const checks = await runPaymentProviderContractChecks(current.provider, {
      initiation,
      expectedInitiationStatus: 'redirect',
      changedReferenceInputs,
      refunds,
      createdPaymentCount: current.createdPaymentCount,
      createdRefundCount: current.createdRefundCount,
    });

    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.some((check) => check.name.includes('identical reference retry creates no additional payment'))).toBe(true);
    expect(checks.filter((check) => check.name.includes('with the same reference returns an explicit conflict'))).toHaveLength(4);
  });

  it('does not treat unsupported refund as proof of supported refund capability', async () => {
    const current = fakeProvider([{ status: 'unsupported', message: 'refund not enabled' }]);
    const checks = await runPaymentProviderContractChecks(current.provider, {
      initiation,
      expectedInitiationStatus: 'confirmed',
      changedReferenceInputs,
      refunds: [{ name: 'required-supported-refund', input: refundInput('refund:required'), expectedStatus: 'succeeded' }],
      createdPaymentCount: current.createdPaymentCount,
      createdRefundCount: current.createdRefundCount,
    });

    expect(checks.some((check) => check.name === 'refund required-supported-refund has expected outcome' && !check.ok)).toBe(true);
  });

  it('validates neutral refund inputs and all explicit result categories', () => {
    const refund = refundInput('refund:attempt-1');
    expect(paymentRefundInputSchema.parse(refund)).toEqual(refund);
    expect(paymentRefundInputSchema.safeParse({ ...refund, orderId: 'order-1' }).success).toBe(false);
    expect(paymentRefundInputSchema.safeParse({ ...refund, amountCents: 10_000 }).success).toBe(false);
    expect(paymentRefundInputSchema.safeParse({ ...refund, amount: 0 }).success).toBe(false);
    expect(paymentRefundInputSchema.safeParse({ ...refund, currency: 'Twd' }).success).toBe(false);

    expect(paymentRefundResultSchema.safeParse({ status: 'succeeded', providerRefundRef: 'refund-1' }).success).toBe(true);
    expect(paymentRefundResultSchema.safeParse({ status: 'unsupported', message: 'refund is not enabled' }).success).toBe(true);
    expect(paymentRefundResultSchema.safeParse({ status: 'rejected', message: 'refund was rejected' }).success).toBe(true);
    expect(paymentRefundResultSchema.safeParse({ status: 'succeeded' }).success).toBe(false);
    expect(paymentRefundResultSchema.safeParse({ status: 'failed', message: 'unknown result' }).success).toBe(false);
    expect(PAYMENT_PROVIDER_CONTRACT_V2.refundOutcomes).toEqual(['succeeded', 'rejected', 'unsupported']);
  });
});
