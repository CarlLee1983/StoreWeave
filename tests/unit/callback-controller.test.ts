import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_ACTOR } from '@storeweave/contracts';
import { createTestExtensionContext, type PaymentProvider, type ShippingProvider } from '@storeweave/extension-sdk';
import { createCheckMacValue, createEcpayPaymentProvider, ecpayPaymentConfig } from '@storeweave/ext-ecpay';
import type { Runtime } from '@storeweave/kernel';
import { CallbackController } from '../../apps/api/src/controllers/callback.controller';
import { describeHttpRoutes } from '../../apps/api/src/http/contract';

type ReplyState = {
  statusCode?: number;
  body?: string;
  headers: Record<string, string>;
};

function replyStub(): { reply: any; state: ReplyState } {
  const state: ReplyState = { headers: {} };
  const reply = {
    status: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return reply;
    }),
    type: vi.fn(() => reply),
    header: vi.fn((name: string, value: string) => {
      state.headers[name] = value;
      return reply;
    }),
    send: vi.fn((body: string) => {
      state.body = body;
      return reply;
    }),
  };
  return { reply, state };
}

function paymentProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    id: 'gateway-a',
    kind: 'payment',
    paymentMethods: () => [],
    start: vi.fn(),
    parseCallback: vi.fn(),
    acknowledgeCallback: vi.fn(() => ({
      statusCode: 202,
      headers: { 'x-provider-ack': 'accepted' },
      body: 'provider accepted',
    })),
    refund: vi.fn(),
    ...overrides,
  } as PaymentProvider;
}

function shippingProvider(overrides: Partial<ShippingProvider> = {}): ShippingProvider {
  return {
    id: 'carrier-a', kind: 'shipping', createShipment: vi.fn(),
    parseCallback: vi.fn(),
    acknowledgeCallback: vi.fn(() => ({ statusCode: 204, body: 'carrier accepted' })),
    ...overrides,
  } as ShippingProvider;
}

function controllerFor(provider: PaymentProvider, options: { get?: () => PaymentProvider; list?: () => Array<{ kind: string; id: string; owner: string; isDefault: boolean }>; execute?: ReturnType<typeof vi.fn> } = {}) {
  const runtime = {
    providers: { get: vi.fn(options.get ?? (() => provider)), list: vi.fn(options.list ?? (() => [])) },
    commands: { execute: options.execute ?? vi.fn(async () => ({})) },
    logger: { warn: vi.fn() },
  };
  return { controller: new CallbackController(runtime as unknown as Runtime), runtime };
}

const ecpaySecrets = {
  ECPAY_MERCHANT_ID: 'test-merchant-id',
  ECPAY_HASH_KEY: 'test-hash-key',
  ECPAY_HASH_IV: 'test-hash-iv',
};

async function startedEcpayProvider() {
  const context = createTestExtensionContext({
    extensionId: 'ecpay',
    config: ecpayPaymentConfig.parse({
      returnUrl: 'https://store.example.test/callbacks/payment/ecpay',
      paymentInfoUrl: 'https://store.example.test/callbacks/payment/ecpay',
    }),
    secrets: ecpaySecrets,
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

function signedEcpayCallback(fields: Record<string, string>): Uint8Array {
  const signed = { ...fields };
  signed.CheckMacValue = createCheckMacValue(signed, ecpaySecrets.ECPAY_HASH_KEY, ecpaySecrets.ECPAY_HASH_IV);
  return new TextEncoder().encode(new URLSearchParams(signed).toString());
}

describe('CallbackController', () => {
  it('catalogs one physical wildcard with only selected callback-capable providers', () => {
    const payment = paymentProvider();
    const shipping = shippingProvider();
    const noAcknowledgement = shippingProvider({ id: 'carrier-without-ack', acknowledgeCallback: undefined });
    const byId = new Map<string, PaymentProvider | ShippingProvider>([
      [payment.id, payment], [shipping.id, shipping], [noAcknowledgement.id, noAcknowledgement],
    ]);
    const { controller, runtime } = controllerFor(payment, {
      list: () => [
        { kind: 'payment', id: payment.id, owner: 'payments-extension', isDefault: true },
        { kind: 'shipping', id: shipping.id, owner: 'shipping-extension', isDefault: true },
        { kind: 'shipping', id: noAcknowledgement.id, owner: 'shipping-extension', isDefault: false },
        { kind: 'erp', id: 'erp-a', owner: 'erp-extension', isDefault: true },
      ],
      get: ((kind: string, id: string) => {
        const provider = byId.get(id);
        if (!provider || provider.kind !== kind) throw new Error('not found');
        return provider;
      }) as () => PaymentProvider,
    });

    const routes = describeHttpRoutes(runtime as unknown as Runtime, [CallbackController]);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'POST', path: '/callbacks/:kind/:providerId', kind: 'provider-callback', request: 'raw',
      auth: 'provider', providerKinds: ['payment', 'shipping'], rateLimit: 'callback',
      targets: [
        { kind: 'payment', providerId: 'gateway-a', owner: 'payments-extension' },
        { kind: 'shipping', providerId: 'carrier-a', owner: 'shipping-extension' },
      ],
      acknowledgements: {
        accepted: { status: 'provider-defined', defaultStatus: 200, headers: 'provider-defined', contentType: 'provider-defined', body: 'provider-defined' },
        rejected: { status: 'provider-defined', defaultStatus: 500, headers: 'provider-defined', contentType: 'provider-defined', body: 'provider-defined' },
      },
      notFound: { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' },
      rateLimited: { status: 429, retryAfter: true, contentType: 'application/json' },
    });
    expect(routes[0]).toHaveProperty('status', null);
    expect(payment.parseCallback).not.toHaveBeenCalled();
    expect(payment.acknowledgeCallback).not.toHaveBeenCalled();
    expect(shipping.parseCallback).not.toHaveBeenCalled();
    expect(shipping.acknowledgeCallback).not.toHaveBeenCalled();

    (runtime.providers.list as ReturnType<typeof vi.fn>).mockReturnValue([]);
    expect(describeHttpRoutes(runtime as unknown as Runtime, [CallbackController])[0]).toMatchObject({ targets: [] });
  });

  it('accepts a signed ECPay callback through the real provider and gives a replay the same opaque idempotency key', async () => {
    const { provider, merchantTradeNo } = await startedEcpayProvider();
    const execute = vi.fn(async () => ({}));
    const { controller, runtime } = controllerFor(provider, { execute });
    const body = signedEcpayCallback({
      MerchantID: ecpaySecrets.ECPAY_MERCHANT_ID,
      MerchantTradeNo: merchantTradeNo!,
      TradeNo: '2408241234567890',
      TradeAmt: '100',
      RtnCode: '1',
      RtnMsg: '交易成功',
    });

    const first = replyStub();
    await controller.handlePayment('payment', 'ecpay', {}, { rawBody: body, headers: {} }, first.reply);
    const replay = replyStub();
    await controller.handlePayment('payment', 'ecpay', {}, { rawBody: body, headers: {} }, replay.reply);

    expect(first.state).toMatchObject({ statusCode: 200, body: '1|OK' });
    expect(replay.state).toMatchObject({ statusCode: 200, body: '1|OK' });
    expect(runtime.commands.execute).toHaveBeenCalledTimes(2);
    const commandCalls = (runtime.commands.execute as ReturnType<typeof vi.fn>).mock.calls;
    const firstOptions = commandCalls[0]![2] as { idempotencyKey: string };
    const replayOptions = commandCalls[1]![2] as { idempotencyKey: string };
    expect(firstOptions.idempotencyKey).toMatch(/^callback:[a-f0-9]{64}$/);
    expect(replayOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
    expect(firstOptions.idempotencyKey).not.toContain(merchantTradeNo!);
  });

  it('rejects a tampered ECPay callback without dispatching a payment command', async () => {
    const { provider, merchantTradeNo } = await startedEcpayProvider();
    const { controller, runtime } = controllerFor(provider);
    const { reply, state } = replyStub();
    const body = signedEcpayCallback({
      MerchantID: ecpaySecrets.ECPAY_MERCHANT_ID,
      MerchantTradeNo: merchantTradeNo!,
      TradeNo: '2408241234567890',
      TradeAmt: '100',
      RtnCode: '1',
    });
    body[0] = body[0] === 77 ? 88 : 77;

    await controller.handlePayment('payment', 'ecpay', {}, { rawBody: body, headers: {} }, reply);

    expect(runtime.commands.execute).not.toHaveBeenCalled();
    expect(state).toMatchObject({ statusCode: 500, body: '0|FAIL' });
  });

  it('passes untouched raw bytes to the provider, records a normalized result as SYSTEM, then sends the provider acknowledgement', async () => {
    const rawBody = new Uint8Array([0, 255, 10, 13, 65]);
    const provider = paymentProvider({
      parseCallback: vi.fn(async () => ({
        type: 'payment_confirmed' as const,
        reference: 'attempt:private-reference',
        providerRef: 'gateway-receipt-7',
      })),
    });
    const { controller, runtime } = controllerFor(provider);
    const { reply, state } = replyStub();

    await controller.handlePayment(
      'payment',
      'gateway-a',
      { echoed: 'yes' },
      { rawBody, headers: { 'x-correlation-id': 'callback-correlation' } },
      reply,
    );

    expect(provider.parseCallback).toHaveBeenCalledWith({
      body: rawBody,
      headers: { 'x-correlation-id': 'callback-correlation' },
      query: { echoed: 'yes' },
    });
    expect(runtime.commands.execute).toHaveBeenCalledWith(
      'commerce.order.recordPaymentResult',
      {
        attemptRef: 'attempt:private-reference',
        provider: 'gateway-a',
        status: 'confirmed',
        providerRef: 'gateway-receipt-7',
      },
      expect.objectContaining({
        actor: SYSTEM_ACTOR,
        correlationId: 'callback-correlation',
        channel: 'rest',
        idempotencyKey: expect.stringMatching(/^callback:[a-f0-9]{64}$/),
      }),
    );
    const commandOptions = (runtime.commands.execute as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { idempotencyKey: string };
    expect(commandOptions.idempotencyKey).not.toContain('private-reference');
    expect(provider.acknowledgeCallback).toHaveBeenCalledExactlyOnceWith({ accepted: true });
    expect(state).toEqual({
      statusCode: 202,
      headers: { 'x-provider-ack': 'accepted' },
      body: 'provider accepted',
    });
  });

  it('does not dispatch a command when provider verification fails and returns that provider’s failure acknowledgement', async () => {
    const provider = paymentProvider({
      parseCallback: vi.fn(async () => { throw new Error('invalid signature'); }),
      acknowledgeCallback: vi.fn(({ accepted }) => accepted
        ? { body: 'unexpected' }
        : { statusCode: 400, headers: { 'x-provider-ack': 'rejected' }, body: 'bad signature' }),
    });
    const { controller, runtime } = controllerFor(provider);
    const { reply, state } = replyStub();

    await controller.handlePayment('payment', 'gateway-a', {}, { rawBody: new Uint8Array([1]), headers: {} }, reply);

    expect(runtime.commands.execute).not.toHaveBeenCalled();
    expect(provider.acknowledgeCallback).toHaveBeenCalledExactlyOnceWith({ accepted: false });
    expect(runtime.logger.warn).toHaveBeenCalledWith({ kind: 'payment', providerId: 'gateway-a', errorType: 'Error' }, 'external callback rejected');
    expect(JSON.stringify((runtime.logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('invalid signature');
    expect(state).toEqual({
      statusCode: 400,
      headers: { 'x-provider-ack': 'rejected' },
      body: 'bad signature',
    });
  });

  it('accepts a verified shipping callback using its opaque carrier identity and retains raw bytes as private evidence', async () => {
    const provider = shippingProvider({
      parseCallback: vi.fn(async () => ({
        providerRef: 'carrier-private-ref', rawStatus: 'carrier-arrived-v7', stage: 'arrived' as const,
        callbackId: 'carrier-event-123', trackingUrl: 'https://carrier.example.test/track/123',
      })),
    });
    const { controller, runtime } = controllerFor(provider as any);
    const { reply, state } = replyStub();

    const rawBody = new Uint8Array([5]);
    await controller.handlePayment('shipping', 'carrier-a', {}, { rawBody, headers: {} }, reply);

    expect(runtime.commands.execute).toHaveBeenCalledWith(
      'commerce.shipping.recordProviderCallback',
      expect.objectContaining({ provider: 'carrier-a', providerRef: 'carrier-private-ref', stage: 'arrived', callbackId: 'carrier-event-123', callbackPayloadBase64: Buffer.from(rawBody).toString('base64') }),
      expect.objectContaining({ actor: SYSTEM_ACTOR, idempotencyKey: expect.stringMatching(/^shipping-callback:[a-f0-9]{64}$/) }),
    );
    const [first] = (runtime.commands.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect((first![2] as any).idempotencyKey).not.toContain('carrier-event-123');
    expect(state).toMatchObject({ statusCode: 204, body: 'carrier accepted' });
  });

  it('returns 404 without resolving a provider for unsupported callback kinds', async () => {
    const provider = paymentProvider();
    const { controller, runtime } = controllerFor(provider);
    const { reply, state } = replyStub();

    await controller.handlePayment('erp', 'gateway-a', {}, { rawBody: new Uint8Array(), headers: {} }, reply);

    expect(runtime.providers.get).not.toHaveBeenCalled();
    expect(state).toEqual({ statusCode: 404, headers: {}, body: 'Not found' });
  });

  it('returns 404 when the payment provider is unknown', async () => {
    const provider = paymentProvider();
    const { controller, runtime } = controllerFor(provider, { get: () => { throw new Error('not found'); } });
    const { reply, state } = replyStub();

    await controller.handlePayment('payment', 'missing', {}, { rawBody: new Uint8Array(), headers: {} }, reply);

    expect(runtime.commands.execute).not.toHaveBeenCalled();
    expect(provider.acknowledgeCallback).not.toHaveBeenCalled();
    expect(state).toEqual({ statusCode: 404, headers: {}, body: 'Not found' });
  });
});
