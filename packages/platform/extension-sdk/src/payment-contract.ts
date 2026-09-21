import { z } from 'zod';
import type {
  PaymentInitiationInput,
  PaymentInitiationResult,
  PaymentProviderV2,
  PaymentRefundInputV2,
  PaymentRefundResult,
} from './providers';

const nonBlank = (max: number) => z.string().max(max).refine((value) => value.trim().length > 0, 'must not be blank');

/** Strict executable shape for the domain-neutral payment initiation input. */
export const paymentInitiationInputSchema: z.ZodType<PaymentInitiationInput> = z.object({
  reference: nonBlank(200),
  displayReference: nonBlank(200),
  amount: z.number().safe().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  method: nonBlank(100),
}).strict();

const paymentRedirectActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('redirect'), url: z.string().url() }).strict(),
  z.object({ type: z.literal('form_post'), url: z.string().url(), fields: z.record(z.string()) }).strict(),
]);

const paymentInstructionSchema = z.object({ label: z.string().min(1), value: z.string().min(1) }).strict();

/** Initiation outcomes use explicit reasons so reference conflicts cannot collapse into generic failures. */
export const paymentInitiationResultSchema: z.ZodType<PaymentInitiationResult> = z.union([
  z.object({ status: z.literal('confirmed'), providerRef: nonBlank(200), message: z.string().optional() }).strict(),
  z.object({ status: z.literal('redirect'), providerRef: nonBlank(200), action: paymentRedirectActionSchema }).strict(),
  z.object({
    status: z.literal('awaiting_payment'),
    providerRef: nonBlank(200),
    instructions: z.array(paymentInstructionSchema),
    expiresAt: z.string().datetime(),
  }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['provider_rejected', 'reference_conflict']),
    providerRef: nonBlank(200).optional(),
    message: nonBlank(500),
  }).strict(),
]);

export const paymentReferenceConflictResultSchema = z.object({
  status: z.literal('failed'),
  reason: z.literal('reference_conflict'),
  providerRef: nonBlank(200).optional(),
  message: nonBlank(500),
}).strict();

/** Domain-neutral refund request using currency minor units. */
export const paymentRefundInputSchema: z.ZodType<PaymentRefundInputV2> = z.object({
  providerRef: nonBlank(200),
  amount: z.number().safe().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reference: nonBlank(200),
}).strict();

export const paymentRefundResultSchema: z.ZodType<PaymentRefundResult> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), providerRefundRef: nonBlank(200), message: z.string().optional() }).strict(),
  z.object({ status: z.literal('rejected'), message: nonBlank(500) }).strict(),
  z.object({ status: z.literal('unsupported'), message: nonBlank(500) }).strict(),
]);

export interface PaymentRefundContractCase {
  readonly name: string;
  readonly input: PaymentRefundInputV2;
  readonly expectedStatus: PaymentRefundResult['status'];
}

export interface PaymentProviderContractFixtures {
  readonly initiation: PaymentInitiationInput;
  readonly expectedInitiationStatus: 'confirmed' | 'redirect' | 'awaiting_payment';
  /**
   * ABI-valid requests that reuse the same reference while changing exactly one fact.
   * Reference conflict takes precedence over provider-specific method/currency support checks.
   */
  readonly changedReferenceInputs: readonly PaymentInitiationConflictCase[];
  /** Adapter-test observation of created provider payment attempts/transactions. */
  readonly createdPaymentCount: () => number | Promise<number>;
  /** Adapter-test observation of created provider refunds. */
  readonly createdRefundCount: () => number | Promise<number>;
  readonly refunds: readonly PaymentRefundContractCase[];
}

export interface PaymentInitiationConflictCase {
  readonly field: 'displayReference' | 'amount' | 'currency' | 'method';
  readonly input: PaymentInitiationInput;
}

export interface PaymentProviderContractCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => [key, normalizeJson(record[key])]));
  }
  return value;
}

function sameResult(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
}

/**
 * Execute the shared V2 contract against an adapter fixture. Adapter tests
 * supply an isolated provider and an observation of durable successful
 * payments so retries/conflicts prove they did not create another charge.
 */
export async function runPaymentProviderContractChecks(
  provider: Pick<PaymentProviderV2, 'initiate' | 'refund'>,
  fixtures: PaymentProviderContractFixtures,
): Promise<PaymentProviderContractCheck[]> {
  const checks: PaymentProviderContractCheck[] = [];
  const push = (name: string, ok: boolean, message?: string) => checks.push({ name, ok, message });
  const initiation = paymentInitiationInputSchema.safeParse(fixtures.initiation);
  push('initiation fixture is valid', initiation.success, initiation.success ? undefined : initiation.error.message);
  if (!initiation.success) return checks;

  let beforeRetryCount: number;
  let initialResult: PaymentInitiationResult;
  try {
    initialResult = await provider.initiate(initiation.data);
    const parsed = paymentInitiationResultSchema.safeParse(initialResult);
    push('initiation result matches the V2 contract', parsed.success, parsed.success ? undefined : parsed.error.message);
    push('initiation has the expected successful outcome', initialResult.status === fixtures.expectedInitiationStatus);
    beforeRetryCount = await fixtures.createdPaymentCount();
  } catch (error) {
    push('initial payment initiation completes', false, error instanceof Error ? error.message : String(error));
    return checks;
  }

  try {
    const replay = await provider.initiate(initiation.data);
    push('identical reference retry replays the same outcome', sameResult(replay, initialResult));
    push('identical reference retry creates no additional payment', (await fixtures.createdPaymentCount()) === beforeRetryCount);
  } catch (error) {
    push('identical reference retry completes', false, error instanceof Error ? error.message : String(error));
  }

  const expectedConflictFields = ['displayReference', 'amount', 'currency', 'method'] as const;
  const suppliedConflictFields = fixtures.changedReferenceInputs.map(({ field }) => field);
  push('changed-reference fixtures cover every payment fact', expectedConflictFields.every((field) => suppliedConflictFields.includes(field)) && suppliedConflictFields.length === expectedConflictFields.length);
  for (const { field, input: conflictInput } of fixtures.changedReferenceInputs) {
    const fieldChanged = conflictInput[field] !== initiation.data[field];
    const onlyFieldChanged = (['displayReference', 'amount', 'currency', 'method'] as const)
      .every((fact) => fact === field || conflictInput[fact] === initiation.data[fact]);
    push(`changed ${field} fixture changes only that payment fact`, fieldChanged && onlyFieldChanged && conflictInput.reference === initiation.data.reference);
    try {
      const validInput = paymentInitiationInputSchema.safeParse(conflictInput);
      if (!validInput.success) {
        push(`changed ${field} fixture remains valid`, false, validInput.error.message);
        continue;
      }
      const conflict = await provider.initiate(validInput.data);
      const parsed = paymentReferenceConflictResultSchema.safeParse(conflict);
      push(`changed ${field} with the same reference returns an explicit conflict`, parsed.success, parsed.success ? undefined : parsed.error.message);
      push(`changed ${field} creates no additional payment`, (await fixtures.createdPaymentCount()) === beforeRetryCount);
    } catch (error) {
      push(`changed ${field} with the same reference is rejected deterministically`, false, error instanceof Error ? error.message : String(error));
    }
  }

  if (fixtures.refunds.length === 0) {
    push('at least one refund outcome is contract-tested', false, 'no refund fixtures were supplied');
  }
  for (const refundCase of fixtures.refunds) {
    const input = paymentRefundInputSchema.safeParse(refundCase.input);
    if (!input.success) {
      push(`refund ${refundCase.name} input is valid`, false, input.error.message);
      continue;
    }
    try {
      const result = await provider.refund(input.data);
      const parsed = paymentRefundResultSchema.safeParse(result);
      push(`refund ${refundCase.name} result matches the contract`, parsed.success, parsed.success ? undefined : parsed.error.message);
      push(`refund ${refundCase.name} has expected outcome`, parsed.success && parsed.data.status === refundCase.expectedStatus);

      const refundCount = await fixtures.createdRefundCount();
      const replay = await provider.refund(input.data);
      push(`refund ${refundCase.name} retry replays the same outcome`, sameResult(replay, result));
      push(`refund ${refundCase.name} retry creates no additional refund`, (await fixtures.createdRefundCount()) === refundCount);

      const conflictInput = { ...input.data, amount: input.data.amount === Number.MAX_SAFE_INTEGER ? input.data.amount - 1 : input.data.amount + 1 };
      const conflict = await provider.refund(conflictInput);
      const validConflict = paymentRefundResultSchema.safeParse(conflict);
      push(`refund ${refundCase.name} changed facts do not report success`, validConflict.success && validConflict.data.status !== 'succeeded');
      push(`refund ${refundCase.name} changed facts create no additional refund`, (await fixtures.createdRefundCount()) === refundCount);
    } catch (error) {
      push(`refund ${refundCase.name} returns a definite outcome`, false, error instanceof Error ? error.message : String(error));
    }
  }
  return checks;
}

/** Executable contract ledger consumed by SDK and adapter tests. */
export const PAYMENT_PROVIDER_CONTRACT_V2 = {
  version: 2,
  initiationInput: paymentInitiationInputSchema,
  initiationResult: paymentInitiationResultSchema,
  referenceConflict: paymentReferenceConflictResultSchema,
  refundInput: paymentRefundInputSchema,
  refundResult: paymentRefundResultSchema,
  refundOutcomes: ['succeeded', 'rejected', 'unsupported'],
  referencePolicy: {
    sameRequest: 'replay-same-outcome-without-another-payment',
    changedRequest: 'reference_conflict-without-another-payment',
    conflictPrecedence: 'existing-reference-before-provider-capability-validation',
  },
} as const;
