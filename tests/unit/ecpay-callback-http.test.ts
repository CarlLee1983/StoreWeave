import { describe, expect, it, vi } from 'vitest';
import { createTestExtensionContext } from '@storeweave/extension-sdk';
import { createCheckMacValue, createEcpayPaymentProvider, ecpayPaymentConfig } from '@storeweave/ext-ecpay';
import type { Runtime } from '@storeweave/kernel';
import { defaultTheme } from '@storeweave/theme-default';
import type { ReleaseHttpAdapter } from '../../apps/api/src/release-adapter';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { CallbackController } from '../../apps/api/src/controllers/callback.controller';
import { describeHttpRoutes } from '../../apps/api/src/http/contract';

const secrets = {
  ECPAY_MERCHANT_ID: 'test-merchant-id',
  ECPAY_HASH_KEY: 'test-hash-key',
  ECPAY_HASH_IV: 'test-hash-iv',
};

const callbackHttpAdapter = {
  releaseId: 'callback-test', anonymousRole: null,
  controllers: () => [CallbackController],
  startSession: async () => null,
} satisfies ReleaseHttpAdapter;

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
        http: { trustProxy: false, bodyLimitBytes: 1_048_576, cors: { allowedOrigins: [], credentials: false } },
        admin: { enabled: false },
        mcp: { enabled: false },
      },
      providers: { get: vi.fn(() => provider), list: () => [
        { kind: 'payment' as const, id: 'ecpay', owner: 'ecpay-extension', isDefault: true },
      ] },
      commands: { execute },
      logger: { warn: vi.fn() },
    } as unknown as Runtime;
    const app = await createReleaseServer({ runtime, theme: defaultTheme, httpAdapter: callbackHttpAdapter, release: { version: 'test', configPath: '<test>' } });

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

  it('keeps provider acknowledgement status, headers, content type, and body outside the REST envelope', async () => {
    const parseCallback = vi.fn(async () => ({ type: 'payment_confirmed' as const, reference: 'attempt:callback-http', providerRef: 'provider-ref' }));
    const acknowledgeCallback = vi.fn(({ accepted }: { accepted: boolean }) => accepted
      ? { statusCode: 202, headers: { 'content-type': 'application/vnd.gateway+text', 'x-provider-ack': 'accepted' }, body: 'provider accepted' }
      : { statusCode: 503, headers: { 'content-type': 'application/vnd.gateway+text', 'x-provider-ack': 'rejected' }, body: 'provider rejected' });
    const payment = {
      id: 'gateway-a', kind: 'payment' as const, paymentMethods: () => [], start: vi.fn(), parseCallback, acknowledgeCallback, refund: vi.fn(),
    };
    const shippingWithoutAcknowledgement = { id: 'carrier-a', kind: 'shipping' as const, createShipment: vi.fn(), parseCallback: vi.fn() };
    const providers = new Map<string, typeof payment | typeof shippingWithoutAcknowledgement>([
      ['payment:gateway-a', payment], ['shipping:carrier-a', shippingWithoutAcknowledgement],
    ]);
    const execute = vi.fn(async () => ({}));
    const runtime = {
      config: { http: { trustProxy: false, bodyLimitBytes: 1_048_576, cors: { allowedOrigins: [], credentials: false } }, admin: { enabled: false }, mcp: { enabled: false } },
      providers: { get: vi.fn((kind: string, id: string) => {
        const provider = providers.get(`${kind}:${id}`);
        if (!provider) throw new Error('not found');
        return provider;
      }), list: () => [
        { kind: 'payment' as const, id: 'gateway-a', owner: 'payments-extension', isDefault: true },
        { kind: 'shipping' as const, id: 'carrier-a', owner: 'shipping-extension', isDefault: true },
      ] },
      commands: { execute }, logger: { warn: vi.fn() },
    } as unknown as Runtime;
    const app = await createReleaseServer({ runtime, theme: defaultTheme, httpAdapter: callbackHttpAdapter, release: { version: 'test', configPath: '<test>' } });

    try {
      const routes = describeHttpRoutes(runtime, [CallbackController]);
      expect(routes).toMatchObject([{ method: 'POST', path: '/callbacks/:kind/:providerId', kind: 'provider-callback', rateLimit: 'callback',
        targets: [{ kind: 'payment', providerId: 'gateway-a', owner: 'payments-extension' }],
      }]);
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: 'POST', url: '/callbacks/:kind/:providerId' })).toBe(true);
      const accepted = await app.inject({ method: 'POST', url: '/callbacks/payment/gateway-a?provider=kept',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'signed=original%2Bbytes' });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.headers['content-type']).toContain('application/vnd.gateway+text');
      expect(accepted.headers['x-provider-ack']).toBe('accepted');
      expect(accepted.body).toBe('provider accepted');
      expect(accepted.body).not.toContain('success');
      expect(parseCallback).toHaveBeenCalledWith(expect.objectContaining({
        body: new TextEncoder().encode('signed=original%2Bbytes'), query: { provider: 'kept' },
      }));

      parseCallback.mockRejectedValueOnce(new Error('invalid signature'));
      const rejected = await app.inject({ method: 'POST', url: '/callbacks/payment/gateway-a',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'signed=bad' });
      expect(rejected.statusCode).toBe(503);
      expect(rejected.headers['content-type']).toContain('application/vnd.gateway+text');
      expect(rejected.headers['x-provider-ack']).toBe('rejected');
      expect(rejected.body).toBe('provider rejected');
      expect(execute).toHaveBeenCalledTimes(1);

      for (const url of ['/callbacks/erp/gateway-a', '/callbacks/payment/missing', '/callbacks/shipping/carrier-a']) {
        const response = await app.inject({ method: 'POST', url, payload: '' });
        expect(response.statusCode, url).toBe(404);
        expect(response.headers['content-type'], url).toContain('text/plain');
        expect(response.body, url).toBe('Not found');
      }
      expect(shippingWithoutAcknowledgement.parseCallback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns the existing 429 REST error and Retry-After before the 301st callback reaches its provider', async () => {
    const parseCallback = vi.fn(async () => ({ type: 'payment_confirmed' as const, reference: 'attempt:rate-limit', providerRef: 'provider-ref' }));
    const payment = {
      id: 'gateway-a', kind: 'payment' as const, paymentMethods: () => [], start: vi.fn(), parseCallback,
      acknowledgeCallback: vi.fn(() => ({ body: 'ok' })), refund: vi.fn(),
    };
    const execute = vi.fn(async () => ({}));
    const runtime = {
      config: { http: { trustProxy: false, bodyLimitBytes: 1_048_576, cors: { allowedOrigins: [], credentials: false } }, admin: { enabled: false }, mcp: { enabled: false } },
      providers: { get: vi.fn(() => payment), list: () => [
        { kind: 'payment' as const, id: 'gateway-a', owner: 'payments-extension', isDefault: true },
      ] }, commands: { execute }, logger: { warn: vi.fn() },
    } as unknown as Runtime;
    const app = await createReleaseServer({ runtime, theme: defaultTheme, httpAdapter: callbackHttpAdapter, release: { version: 'test', configPath: '<test>' } });

    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        expect((await app.inject({ method: 'POST', url: '/callbacks/payment/gateway-a',
          headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'signed=ok' })).statusCode).toBe(200);
      }
      const limited = await app.inject({ method: 'POST', url: '/callbacks/payment/gateway-a',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'signed=ok' });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['content-type']).toContain('application/json');
      expect(limited.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(parseCallback).toHaveBeenCalledTimes(300);
      expect(execute).toHaveBeenCalledTimes(300);
    } finally {
      await app.close();
    }
  });
});
