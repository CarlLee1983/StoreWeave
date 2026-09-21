import { createHash } from 'node:crypto';
import {
  paymentInitiationInputSchema,
  paymentRefundInputSchema,
} from '@storeweave/extension-sdk';
import type {
  ExtensionContext,
  PaymentCallbackEvent,
  PaymentCallbackHandlingResult,
  PaymentCallbackRequest,
  PaymentInitiationInput,
  PaymentInitiationResult,
  PaymentProviderV2,
  PaymentRefundInputV2,
  PaymentRefundResult,
} from '@storeweave/extension-sdk';
import type { MockPaymentConfig } from './config';

/** Provider id 是契約的一部分，必須與 manifest.registeredProviders 一致，因此不可由設定改變。 */
export const MOCK_PAYMENT_PROVIDER_ID = 'mock-payment';
export const MOCK_PAYMENT_METHOD = 'mock';

interface StoredRefund {
  readonly request: PaymentRefundInputV2;
  readonly result: PaymentRefundResult;
}

interface ChargeRecord {
  readonly providerRef: string;
  /** Retained so the previous adapter version can still read successful charges. */
  readonly amountCents: number;
  readonly status: 'confirmed';
  readonly chargedAt: string;
  /** Complete domain-neutral facts are present on records written by this adapter version. */
  readonly facts?: PaymentInitiationInput;
  readonly result?: PaymentInitiationResult;
  readonly refunds?: readonly StoredRefund[];
}

interface StoredRefundReference {
  readonly status?: 'pending' | 'succeeded' | 'rejected';
  readonly paymentReference?: string;
  readonly request?: PaymentRefundInputV2;
  readonly result?: PaymentRefundResult;
}

interface LegacyStoredRefund {
  readonly providerRefundRef?: string;
  readonly providerRef?: string;
  readonly amountCents?: number;
  readonly currency?: string;
}

interface RefundOutcome {
  readonly result: PaymentRefundResult;
  readonly replayed: boolean;
}

/**
 * Mock payment adapter backed by the domain-neutral payment and refund contract.
 */
export function createMockPaymentProvider(
  ctx: ExtensionContext<MockPaymentConfig>,
): PaymentProviderV2 {
  const config = ctx.config;

  async function initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult> {
    const valid = paymentInitiationInputSchema.safeParse(input);
    if (!valid.success) {
      return { status: 'failed', reason: 'provider_rejected', message: 'invalid payment initiation input' };
    }
    return initiateNeutral(valid.data);
  }

  async function initiateNeutral(input: PaymentInitiationInput): Promise<PaymentInitiationResult> {
    const key = `payment:${input.reference}`;
    const existingBeforeDelay = await ctx.store.get<ChargeRecord>(key);
    if (!existingBeforeDelay && config.latencyMs > 0) await sleep(config.latencyMs);

    let outcome: PaymentInitiationResult | undefined;
    await ctx.store.mutate<ChargeRecord | null>(key, (existing) => {
      if (existing) {
        if (sameInitiation(existing.facts, input)) {
          outcome = existing.result ?? confirmedResult(existing.providerRef);
          return existing;
        }
        outcome = {
          status: 'failed',
          reason: 'reference_conflict',
          providerRef: existing.providerRef,
          message: 'reference is already used for different payment facts',
        };
        return existing;
      }

      if (input.method !== MOCK_PAYMENT_METHOD) {
        outcome = { status: 'failed', reason: 'provider_rejected', message: `unsupported mock payment method: ${input.method}` };
        return null;
      }

      const providerRef = providerPaymentReference(input.reference);
      const declined =
        !config.autoApprove ||
        (config.declineAboveCents > 0 && input.amount > config.declineAboveCents);
      if (declined) {
        outcome = {
          status: 'failed',
          reason: 'provider_rejected',
          providerRef,
          message: 'declined by mock payment configuration',
        };
        return null;
      }

      const result = confirmedResult(providerRef);
      outcome = result;
      return {
        providerRef,
        amountCents: input.amount,
        status: 'confirmed',
        chargedAt: ctx.now().toISOString(),
        facts: input,
        result,
        refunds: [],
      };
    });

    if (!outcome) throw new Error('mock payment store did not produce an initiation outcome');
    if (outcome.status === 'confirmed') {
      // The payment record is authoritative; a missing index only makes a refund unavailable.
      await ctx.store.set(`paymentByProviderRef:${outcome.providerRef}`, input.reference);
    }
    return outcome;
  }

  async function refund(input: PaymentRefundInputV2): Promise<PaymentRefundResult> {
    return (await refundNeutral(input)).result;
  }

  async function refundNeutral(input: PaymentRefundInputV2): Promise<RefundOutcome> {
    const valid = paymentRefundInputSchema.safeParse(input);
    if (!valid.success) return rejectedRefund('invalid refund input');

    const refundKey = `refundV2:${input.reference}`;
    const legacyRefundKey = `refund:${input.reference}`;
    const existingV2Refund = await ctx.store.get<StoredRefundReference>(refundKey);
    const legacyRefund = await ctx.store.get<LegacyStoredRefund>(legacyRefundKey);
    if (!existingV2Refund && legacyRefund) {
      if (matchesLegacyRefund(legacyRefund, input)) {
        return {
          result: { status: 'succeeded', providerRefundRef: legacyRefund.providerRefundRef! },
          replayed: true,
        };
      }
      return rejectedRefund('legacy refund record does not match this request');
    }

    let paymentReference = await ctx.store.get<string>(`paymentByProviderRef:${input.providerRef}`);
    let paymentKey = paymentReference ? `payment:${paymentReference}` : undefined;
    let charge = paymentKey ? await ctx.store.get<ChargeRecord>(paymentKey) : null;
    if (!paymentReference || !paymentKey || !charge || charge.status !== 'confirmed' || charge.providerRef !== input.providerRef) {
      return rejectedRefund('payment is unavailable for refund');
    }
    if (!charge.facts) {
      return rejectedRefund('payment is unavailable for a domain-neutral refund');
    }

    let reservation: StoredRefundReference | undefined;
    await ctx.store.mutate<StoredRefundReference | null>(refundKey, (current) => {
      if (!current) {
        reservation = {
          status: 'pending',
          paymentReference,
          request: input,
        };
        return reservation;
      }
      if (sameRefundReference(current, paymentReference, input)) reservation = current;
      return current;
    });

    if (
      !reservation ||
      !reservation.request ||
      reservation.paymentReference !== paymentReference ||
      !sameRefundInput(reservation.request, input)
    ) {
      return rejectedRefund('refund reference is already used for different facts');
    }
    if (reservation.result) {
      if (reservation.result.status === 'succeeded') {
        await writeLegacyRefundSuccess(legacyRefundKey, input, reservation.result);
      }
      return { result: reservation.result, replayed: true };
    }

    const refundOutcome: { result: PaymentRefundResult } = {
      result: { status: 'rejected', message: 'refund is unavailable' },
    };
    await ctx.store.mutate<ChargeRecord | null>(paymentKey, (current) => {
      if (!current) return current;
      const previous = current.refunds?.find((refundRecord) => refundRecord.request.reference === input.reference);
      if (previous) {
        refundOutcome.result = sameRefundInput(previous.request, input)
          ? previous.result
          : { status: 'rejected', message: 'refund reference is already used for different facts' };
        return current;
      }

      const hasSuccessfulRefund = current.refunds?.some((refundRecord) => refundRecord.result.status === 'succeeded') ?? false;
      if (current.providerRef !== input.providerRef || current.status !== 'confirmed') {
        refundOutcome.result = { status: 'rejected', message: 'payment is unavailable for refund' };
      } else if (
        !current.facts ||
        (current.facts && current.facts.currency !== input.currency) ||
        input.amount > (current.facts?.amount ?? current.amountCents) ||
        hasSuccessfulRefund
      ) {
        refundOutcome.result = { status: 'rejected', message: 'refund amount or currency is unavailable' };
      } else {
        refundOutcome.result = {
          status: 'succeeded',
          providerRefundRef: providerRefundReference(input.reference),
        };
      }

      return {
        ...current,
        refunds: [...(current.refunds ?? []), { request: input, result: refundOutcome.result }],
      };
    });

    const result = refundOutcome.result;
    const finalRecord: StoredRefundReference = {
      ...reservation,
      status: result.status === 'succeeded' ? 'succeeded' : 'rejected',
      result,
      ...(result.status === 'succeeded' ? { providerRefundRef: result.providerRefundRef } : {}),
    };
    await ctx.store.set(refundKey, finalRecord);
    if (result.status === 'succeeded') await writeLegacyRefundSuccess(legacyRefundKey, input, result);
    return { result, replayed: false };
  }

  async function writeLegacyRefundSuccess(
    key: string,
    input: PaymentRefundInputV2,
    result: PaymentRefundResult,
  ): Promise<void> {
    if (result.status !== 'succeeded') return;
    await ctx.store.set(key, {
      providerRefundRef: result.providerRefundRef,
      providerRef: input.providerRef,
      amountCents: input.amount,
      currency: input.currency,
    });
  }

  return {
    id: MOCK_PAYMENT_PROVIDER_ID,
    kind: 'payment',

    paymentMethods() {
      return [{ code: MOCK_PAYMENT_METHOD, label: 'Mock payment', timing: 'immediate' as const }];
    },

    initiate,
    refund,

    async parseCallback(request: PaymentCallbackRequest): Promise<PaymentCallbackEvent> {
      const event = parseMockCallback(JSON.parse(new TextDecoder().decode(request.body)));
      const charge = await ctx.store.get<ChargeRecord>(`payment:${event.reference}`);
      if (!charge) throw new Error('mock payment callback references an unknown payment');
      if ('providerRef' in event && event.providerRef !== undefined && event.providerRef !== charge.providerRef) {
        throw new Error('mock payment callback provider reference does not match the payment');
      }
      return event;
    },

    acknowledgeCallback(result: PaymentCallbackHandlingResult) {
      return { statusCode: result.accepted ? 200 : 400, body: result.accepted ? 'OK' : 'REJECTED' };
    },

    async healthCheck() {
      return { ok: true, message: config.autoApprove ? 'auto-approving charges' : 'declining all charges' };
    },
  };
}

function confirmedResult(providerRef: string): PaymentInitiationResult {
  return { status: 'confirmed', providerRef };
}

function sameInitiation(left: PaymentInitiationInput | undefined, right: PaymentInitiationInput): boolean {
  return left !== undefined &&
    left.reference === right.reference &&
    left.displayReference === right.displayReference &&
    left.amount === right.amount &&
    left.currency === right.currency &&
    left.method === right.method;
}

function sameRefundInput(left: PaymentRefundInputV2, right: PaymentRefundInputV2): boolean {
  return left.providerRef === right.providerRef &&
    left.amount === right.amount &&
    left.currency === right.currency &&
    left.reference === right.reference;
}

function matchesLegacyRefund(record: LegacyStoredRefund, input: PaymentRefundInputV2): boolean {
  return typeof record.providerRefundRef === 'string' && record.providerRefundRef.trim().length > 0 &&
    record.providerRef === input.providerRef &&
    record.amountCents === input.amount &&
    record.currency === input.currency;
}

function sameRefundReference(current: StoredRefundReference, paymentReference: string, input: PaymentRefundInputV2): boolean {
  return current.paymentReference === paymentReference && current.request !== undefined && sameRefundInput(current.request, input);
}

function rejectedRefund(message: string): RefundOutcome {
  return { result: { status: 'rejected', message }, replayed: false };
}

function providerPaymentReference(reference: string): string {
  return `mock_${createHash('sha256').update(reference).digest('hex').slice(0, 20)}`;
}

function providerRefundReference(reference: string): string {
  return `mock_refund_${createHash('sha256').update(reference).digest('hex').slice(0, 20)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMockCallback(value: unknown): PaymentCallbackEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.reference !== 'string') {
    throw new Error('invalid mock payment callback');
  }

  switch (value.type) {
    case 'payment_confirmed':
      if (typeof value.providerRef !== 'string') throw new Error('invalid confirmed payment callback');
      return { type: value.type, reference: value.reference, providerRef: value.providerRef };
    case 'payment_info_issued':
      if (
        typeof value.providerRef !== 'string' ||
        typeof value.expiresAt !== 'string' ||
        !Array.isArray(value.instructions) ||
        !value.instructions.every(isPaymentInstruction)
      ) {
        throw new Error('invalid payment-info callback');
      }
      return {
        type: value.type,
        reference: value.reference,
        providerRef: value.providerRef,
        instructions: value.instructions,
        expiresAt: value.expiresAt,
      };
    case 'payment_failed':
      if (value.providerRef !== undefined && typeof value.providerRef !== 'string') {
        throw new Error('invalid failed payment callback');
      }
      if (value.message !== undefined && typeof value.message !== 'string') {
        throw new Error('invalid failed payment callback');
      }
      return {
        type: value.type,
        reference: value.reference,
        ...(value.providerRef !== undefined ? { providerRef: value.providerRef } : {}),
        ...(value.message !== undefined ? { message: value.message } : {}),
      };
    default:
      throw new Error(`unsupported mock payment callback type: ${value.type}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPaymentInstruction(value: unknown): value is { label: string; value: string } {
  return isRecord(value) && typeof value.label === 'string' && typeof value.value === 'string';
}
