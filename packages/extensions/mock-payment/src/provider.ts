import { createHash } from 'node:crypto';
import type { ExtensionContext, PaymentChargeInput, PaymentChargeResult, PaymentProvider } from '@storeweave/extension-sdk';
import type { MockPaymentConfig } from './config';

/** Provider id 是契約的一部分，必須與 manifest.registeredProviders 一致，因此不可由設定改變。 */
export const MOCK_PAYMENT_PROVIDER_ID = 'mock-payment';

interface ChargeRecord {
  providerRef: string;
  amountCents: number;
  status: 'succeeded' | 'failed';
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

    async charge(input: PaymentChargeInput): Promise<PaymentChargeResult> {
      const key = `charge:${input.reference}`;
      const existing = await ctx.store.get<ChargeRecord>(key);
      if (existing) {
        ctx.logger.info({ reference: input.reference, providerRef: existing.providerRef }, 'replaying existing charge');
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
        status: declined ? 'failed' : 'succeeded',
        chargedAt: ctx.now().toISOString(),
      };
      // 只有成功才留紀錄；失敗允許之後重試
      if (!declined) await ctx.store.set(key, record);

      return {
        status: record.status,
        providerRef,
        message: declined ? 'declined by mock payment configuration' : undefined,
      };
    },

    async refund(input) {
      const key = `refund:${input.providerRef}`;
      const existing = await ctx.store.get<{ status: 'succeeded' }>(key);
      if (existing) return { status: 'succeeded', message: 'replayed' };
      await ctx.store.set(key, { status: 'succeeded', amountCents: input.amountCents });
      return { status: 'succeeded' };
    },

    async healthCheck() {
      return { ok: true, message: config.autoApprove ? 'auto-approving charges' : 'declining all charges' };
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
