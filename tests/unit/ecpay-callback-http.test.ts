import { describe, expect, it, vi } from 'vitest';
import { createTestExtensionContext } from '@storeweave/extension-sdk';
import { createCheckMacValue, createEcpayPaymentProvider, ecpayPaymentConfig } from '@storeweave/ext-ecpay';
import type { Runtime } from '@storeweave/kernel';
import { defaultTheme } from '@storeweave/theme-default';
import { createServer } from '../../apps/api/src/server';

const secrets = {
  ECPAY_MERCHANT_ID: 'test-merchant-id',
  ECPAY_HASH_KEY: 'test-hash-key',
  ECPAY_HASH_IV: 'test-hash-iv',
};

async function providerWithStartedTrade() {
  const context = createTestExtensionContext({
    extensionId: 'ecpay',
    config: ecpayPaymentConfig.parse({
      returnUrl: 'https://store.example.test/callbacks/payment/ecpay',
      paymentInfoUrl: 'https://store.example.test/callbacks/payment/ecpay',
    }),
    secrets,
    now: () => new Date('2026-08-24T12:34:56.000Z'),
  });
  const provider = createEcpayPaymentProvider(context);
  const start = await provider.start({
    orderId: '11111111-1111-4111-8111-111111111111',
    orderNumber: 'SW-1000',
    amountCents: 10_000,
    currency: 'TWD',
    method: 'card',
    reference: 'attempt:11111111-1111-4111-8111-111111111111',
  });
  if (start.status !== 'redirect') throw new Error('expected ECPay redirect');
  return { provider, merchantTradeNo: start.providerRef };
}

function callbackBody(fields: Record<string, string>): string {
  const signed = { ...fields };
  signed.CheckMacValue = createCheckMacValue(signed, secrets.ECPAY_HASH_KEY, secrets.ECPAY_HASH_IV);
  return new URLSearchParams(signed).toString();
}

describe('ECPay callback HTTP route', () => {
  it('keeps the form body for verification, bypasses API-token auth, and acknowledges a durable callback', async () => {
    const { provider, merchantTradeNo } = await providerWithStartedTrade();
    const execute = vi.fn(async () => ({}));
    const runtime = {
      config: {
        http: { trustProxy: false, bodyLimitBytes: 1_048_576 },
        admin: { enabled: false },
        mcp: { enabled: false },
      },
      providers: { get: vi.fn(() => provider) },
      commands: { execute },
      logger: { warn: vi.fn() },
    } as unknown as Runtime;
    const app = await createServer({ runtime, theme: defaultTheme, release: { version: 'test', configPath: '<test>' } });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/callbacks/payment/ecpay',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: callbackBody({
          MerchantID: secrets.ECPAY_MERCHANT_ID,
          MerchantTradeNo: merchantTradeNo!,
          TradeNo: '2408241234567890',
          TradeAmt: '100',
          RtnCode: '1',
          RtnMsg: '交易成功',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('1|OK');
      expect(response.headers['content-type']).toContain('text/plain');
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        'commerce.order.recordPaymentResult',
        expect.objectContaining({ provider: 'ecpay', status: 'confirmed' }),
        expect.objectContaining({ idempotencyKey: expect.stringMatching(/^callback:[a-f0-9]{64}$/) }),
      );
    } finally {
      await app.close();
    }
  });
});
