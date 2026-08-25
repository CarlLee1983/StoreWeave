import { createHash } from 'node:crypto';
import type {
  ExtensionContext,
  PaymentCallbackEvent,
  PaymentCallbackHandlingResult,
  PaymentCallbackRequest,
  PaymentProvider,
  PaymentStartInput,
  PaymentStartResult,
} from '@storeweave/extension-sdk';
import type { MockPaymentConfig } from './config';

/** Provider id 是契約的一部分，必須與 manifest.registeredProviders 一致，因此不可由設定改變。 */
export const MOCK_PAYMENT_PROVIDER_ID = 'mock-payment';
export const MOCK_PAYMENT_METHOD = 'mock';

interface ChargeRecord {
  providerRef: string;
  amountCents: number;
  status: 'confirmed';
  chargedAt: string;
}

/**
 * 模擬金流。真正的重點是示範 Provider Contract 的冪等要求：
 * 同一個 `reference` 重複請求只會產生一筆收款，回傳同一個 providerRef。
 */
export function createMockPaymentProvider(
  ctx: ExtensionContext<MockPaymentConfig>,
): PaymentProvider {
  const config = ctx.config;
  return {
    id: MOCK_PAYMENT_PROVIDER_ID,
    kind: 'payment',

    paymentMethods() {
      return [{ code: MOCK_PAYMENT_METHOD, label: 'Mock payment', timing: 'immediate' as const }];
    },

    async start(input: PaymentStartInput): Promise<PaymentStartResult> {
      if (input.method !== MOCK_PAYMENT_METHOD) {
        return { status: 'failed', message: `unsupported mock payment method: ${input.method}` };
      }
      const key = `payment:${input.reference}`;
      const existing = await ctx.store.get<ChargeRecord>(key);
      if (existing) {
        ctx.logger.info({ reference: input.reference, providerRef: existing.providerRef }, 'replaying existing payment');
        return { status: existing.status, providerRef: existing.providerRef, message: 'replayed' };
      }

      if (config.latencyMs > 0) await sleep(config.latencyMs);

      const declined =
        !config.autoApprove ||
        (config.declineAboveCents > 0 && input.amountCents > config.declineAboveCents);

      const providerRef = `mock_${createHash('sha256').update(input.reference).digest('hex').slice(0, 20)}`;
      const record: ChargeRecord = {
        providerRef,
        amountCents: input.amountCents,
        status: 'confirmed',
        chargedAt: ctx.now().toISOString(),
      };
      // 只有成功才留紀錄；失敗允許之後重試
      if (!declined) await ctx.store.set(key, record);

      if (declined) return { status: 'failed', providerRef, message: 'declined by mock payment configuration' };
      return { status: record.status, providerRef };
    },

    async parseCallback(request: PaymentCallbackRequest): Promise<PaymentCallbackEvent> {
      // The mock has no shared secret. Parsing the complete raw body in this
      // one method intentionally mirrors the atomic verify-and-parse boundary
      // real providers must implement.
      const parsed: unknown = JSON.parse(new TextDecoder().decode(request.body));
      return parseMockCallback(parsed);
    },

    acknowledgeCallback(result: PaymentCallbackHandlingResult) {
      return { statusCode: result.accepted ? 200 : 400, body: result.accepted ? 'OK' : 'REJECTED' };
    },

    async refund(input) {
      const key = `refund:${input.reference}`;
      const existing = await ctx.store.get<{ providerRefundRef: string }>(key);
      if (existing) return { status: 'succeeded', providerRefundRef: existing.providerRefundRef, message: 'replayed' };
      const providerRefundRef = `mock_refund_${createHash('sha256').update(input.reference).digest('hex').slice(0, 20)}`;
      await ctx.store.set(key, { providerRefundRef, providerRef: input.providerRef, amountCents: input.amountCents, currency: input.currency });
      return { status: 'succeeded', providerRefundRef };
    },

    async healthCheck() {
      return { ok: true, message: config.autoApprove ? 'auto-approving charges' : 'declining all charges' };
    },
  };
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
      return { type: value.type, reference: value.reference, providerRef: value.providerRef, message: value.message };
    default:
      throw new Error('unsupported mock payment callback');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPaymentInstruction(value: unknown): value is { label: string; value: string } {
  return isRecord(value) && typeof value.label === 'string' && typeof value.value === 'string';
}
