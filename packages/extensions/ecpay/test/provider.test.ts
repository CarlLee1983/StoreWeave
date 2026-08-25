import { describe, expect, it } from 'vitest';
import { createTestExtensionContext } from '@storeweave/extension-sdk';
import {
  createCheckMacValue,
  createEcpayPaymentProvider,
  ecpayPaymentConfig,
  ECPAY_STAGE_CHECKOUT_URL,
} from '../src';

const secrets = { ECPAY_MERCHANT_ID: 'test-merchant-id', ECPAY_HASH_KEY: 'test-hash-key', ECPAY_HASH_IV: 'test-hash-iv' };
const input = { orderId: '11111111-1111-4111-8111-111111111111', orderNumber: 'SW-1000', amountCents: 10_000, currency: 'TWD', method: 'card', reference: 'order:11111111-1111-4111-8111-111111111111' };
const callbackUrl = 'https://store.example.test/callbacks/payment/ecpay';

function provider() {
  const ctx = createTestExtensionContext({
    extensionId: 'ecpay',
    config: ecpayPaymentConfig.parse({ returnUrl: callbackUrl, paymentInfoUrl: callbackUrl }),
    secrets,
    now: () => new Date('2026-08-24T12:34:56.000Z'),
  });
  return { provider: createEcpayPaymentProvider(ctx), ctx };
}

function providerWithMethods(enabledMethods: string[]) {
  const ctx = createTestExtensionContext({
    extensionId: 'ecpay',
    config: ecpayPaymentConfig.parse({ returnUrl: callbackUrl, paymentInfoUrl: callbackUrl, enabledMethods }),
    secrets,
    now: () => new Date('2026-08-24T12:34:56.000Z'),
  });
  return createEcpayPaymentProvider(ctx);
}

async function startedWith(method: 'atm' | 'cvs_code' | 'cvs_barcode') {
  const current = providerWithMethods([method]);
  const result = await current.start({ ...input, method, reference: `${input.reference}:${method}` });
  if (result.status !== 'redirect' || result.action.type !== 'form_post') throw new Error('expected form post');
  return { provider: current, result, reference: `${input.reference}:${method}` };
}

async function started() {
  const current = provider();
  const result = await current.provider.start(input);
  if (result.status !== 'redirect' || result.action.type !== 'form_post') throw new Error('expected form post');
  return { ...current, result };
}

function callback(fields: Record<string, string>) {
  const signed = { ...fields };
  signed.CheckMacValue = createCheckMacValue(signed, secrets.ECPAY_HASH_KEY, secrets.ECPAY_HASH_IV);
  return { body: new TextEncoder().encode(new URLSearchParams(signed).toString()), headers: {}, query: {} };
}

describe('ECPay CheckMacValue', () => {
  it('is stable for a synthetic SHA-256 AIO fixture', () => {
    expect(createCheckMacValue({
      TradeDesc: '促銷方案', PaymentType: 'aio', MerchantTradeDate: '2023/03/12 15:30:23', MerchantTradeNo: 'ecpay20230312153023', MerchantID: secrets.ECPAY_MERCHANT_ID, ReturnURL: 'https://www.ecpay.com.tw/receive.php', ItemName: 'Apple iphone 15', TotalAmount: '30000', ChoosePayment: 'ALL', EncryptType: '1',
    }, secrets.ECPAY_HASH_KEY, secrets.ECPAY_HASH_IV)).toBe('F4DBFEE955855E30CCDF198270357D05DFD42FCBFAF9018AFC1B81E42EDDFB55');
  });
});

describe('ECPay release configuration', () => {
  it('requires secret-provider credentials and rejects credentials in the extension configuration', () => {
    const config = ecpayPaymentConfig.parse({ returnUrl: callbackUrl });
    expect(() => createEcpayPaymentProvider(createTestExtensionContext({ extensionId: 'ecpay', config }))).toThrow(/required secrets/);
    expect(() => ecpayPaymentConfig.parse({ returnUrl: callbackUrl, merchantId: 'must-not-be-in-yaml' })).toThrow(/unrecognized/i);
  });

  it('requires HTTPS, non-credential-bearing URLs and rejects duplicate methods before mounting', () => {
    expect(() => ecpayPaymentConfig.parse({ returnUrl: 'http://store.example.test/callbacks/payment/ecpay' })).toThrow(/https/);
    expect(() => ecpayPaymentConfig.parse({ returnUrl: 'https://merchant:secret@store.example.test/callbacks/payment/ecpay' })).toThrow(/credentials/);
    expect(() => ecpayPaymentConfig.parse({ returnUrl: `${callbackUrl}#fragment` })).toThrow(/fragment/);
    expect(() => ecpayPaymentConfig.parse({ returnUrl: `${callbackUrl}?route=payment` })).toThrow(/query/);
    expect(() => ecpayPaymentConfig.parse({
      returnUrl: callbackUrl,
      paymentInfoUrl: 'http://store.example.test/callbacks/payment/ecpay',
      enabledMethods: ['atm'],
    })).toThrow(/https/);
    expect(() => ecpayPaymentConfig.parse({ returnUrl: callbackUrl, clientBackUrl: 'http://store.example.test/account/orders' })).toThrow(/https/);
    expect(() => ecpayPaymentConfig.parse({ returnUrl: callbackUrl, enabledMethods: ['card', 'card'] })).toThrow(/duplicate/);
  });
});

describe('ECPay payment provider', () => {
  it('starts an ECPay checkout with a signed form post and replays the provider reference', async () => {
    const { provider: p, result } = await started();
    if (result.action.type !== 'form_post') throw new Error('expected form post');
    expect(result.action.url).toBe(ECPAY_STAGE_CHECKOUT_URL);
    expect(result.action.fields.TotalAmount).toBe('100');
    expect(result.action.fields.ChoosePayment).toBe('Credit');
    expect(result.action.fields.EncryptType).toBe('1');
    expect(result.action.fields.CheckMacValue).toMatch(/^[A-F0-9]{64}$/);
    const replay = await p.start(input);
    if (replay.status !== 'redirect' || replay.action.type !== 'form_post') throw new Error('expected form post');
    expect(replay.providerRef).toBe(result.providerRef);
    expect(replay.action).toEqual(result.action);
  });

  it('rejects currencies and amounts that ECPay AIO cannot represent', async () => {
    const { provider: p } = provider();
    await expect(p.start({ ...input, currency: 'USD' })).resolves.toMatchObject({ status: 'failed' });
    await expect(p.start({ ...input, amountCents: 10_050 })).resolves.toMatchObject({ status: 'failed' });
    await expect(p.start({ ...input, amountCents: 0 })).resolves.toMatchObject({ status: 'failed' });
    await expect(p.start({ ...input, amountCents: -100 })).resolves.toMatchObject({ status: 'failed' });
    await expect(p.start({ ...input, amountCents: Number.MAX_SAFE_INTEGER + 1 })).resolves.toMatchObject({ status: 'failed' });
  });

  it('exposes only enabled store methods and maps each selected method deterministically', async () => {
    const p = providerWithMethods(['card', 'atm', 'cvs_code', 'cvs_barcode']);
    expect(p.paymentMethods()).toEqual([
      { code: 'card', label: 'Credit card', timing: 'immediate' },
      { code: 'atm', label: 'ATM transfer', timing: 'deferred' },
      { code: 'cvs_code', label: 'Convenience store code', timing: 'deferred' },
      { code: 'cvs_barcode', label: 'Convenience store barcode', timing: 'deferred' },
    ]);
    for (const [method, choosePayment] of Object.entries({ card: 'Credit', atm: 'ATM', cvs_code: 'CVS', cvs_barcode: 'BARCODE' })) {
      const result = await p.start({ ...input, method, reference: `${input.reference}:${method}` });
      if (result.status !== 'redirect' || result.action.type !== 'form_post') throw new Error('expected form post');
      expect(result.action.fields.ChoosePayment).toBe(choosePayment);
    }
  });

  it('requires a payment-info callback whenever a deferred method is enabled', () => {
    expect(() => ecpayPaymentConfig.parse({ returnUrl: 'https://store.example.test/payments/ecpay/callback', enabledMethods: ['atm'] })).toThrow(/paymentInfoUrl/);
    expect(() => ecpayPaymentConfig.parse({ returnUrl: 'https://store.example.test/payments/ecpay/callback', enabledMethods: ['card'] })).not.toThrow();
  });

  it('rejects unknown and disabled requested methods', async () => {
    const { provider: p } = provider();
    await expect(p.start({ ...input, method: 'atm' })).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/not enabled/) });
    await expect(p.start({ ...input, method: 'bank_transfer' })).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/Unsupported/) });
  });

  it('verifies and maps a paid callback to a normalized confirmation', async () => {
    const { provider: p, result } = await started();
    await expect(p.parseCallback(callback({ MerchantID: secrets.ECPAY_MERCHANT_ID, MerchantTradeNo: result.providerRef, TradeNo: '2408241234567890', TradeAmt: '100', RtnCode: '1', RtnMsg: '交易成功' }))).resolves.toEqual({ type: 'payment_confirmed', reference: input.reference, providerRef: '2408241234567890' });
  });

  it('maps issued ATM instructions and rejects tampered callbacks', async () => {
    const { provider: p, result, reference } = await startedWith('atm');
    await expect(p.parseCallback(callback({ MerchantID: secrets.ECPAY_MERCHANT_ID, MerchantTradeNo: result.providerRef, TradeNo: '2408241234567890', TradeAmt: '100', RtnCode: '2', BankCode: '822', vAccount: '1234567890123456', ExpireDate: '2026/08/30' }))).resolves.toMatchObject({ type: 'payment_info_issued', reference, instructions: [{ label: 'Bank code', value: '822' }, { label: 'Virtual account', value: '1234567890123456' }], expiresAt: '2026-08-30T15:59:59.000Z' });
    await expect(p.parseCallback({ body: new TextEncoder().encode('MerchantID=test-merchant-id&MerchantTradeNo=bad&CheckMacValue=bad'), headers: {}, query: {} })).rejects.toThrow(/CheckMacValue/);
  });

  it('parses CVS and barcode date-time expiry fields in Taiwan time', async () => {
    const { provider: p, result, reference } = await startedWith('cvs_code');
    await expect(p.parseCallback(callback({ MerchantID: secrets.ECPAY_MERCHANT_ID, MerchantTradeNo: result.providerRef, TradeNo: '2408241234567890', TradeAmt: '100', RtnCode: '10100073', PaymentNo: 'LLL17355880822', ExpireDate: '2026/08/30 12:34:56' }))).resolves.toMatchObject({ type: 'payment_info_issued', reference, expiresAt: '2026-08-30T04:34:56.000Z' });
  });

  it('does not issue deferred-payment instructions from an ECPay failure status', async () => {
    const { provider: p, result, reference } = await startedWith('cvs_barcode');
    await expect(p.parseCallback(callback({ MerchantID: secrets.ECPAY_MERCHANT_ID, MerchantTradeNo: result.providerRef, TradeNo: '2408241234567890', TradeAmt: '100', RtnCode: '10100099', RtnMsg: 'Get barcode failed', Barcode1: '123456789', Barcode2: '1234567890123456', Barcode3: '123456789012345', ExpireDate: '2026/08/30 12:34:56' }))).resolves.toEqual({ type: 'payment_failed', reference, providerRef: '2408241234567890', message: 'Get barcode failed' });
  });

  it('uses ECPay’s exact acknowledgement only after durable acceptance', () => {
    const { provider: p } = provider();
    expect(p.acknowledgeCallback({ accepted: true })).toMatchObject({ statusCode: 200, body: '1|OK' });
    expect(p.acknowledgeCallback({ accepted: false, duplicate: true })).toMatchObject({ statusCode: 200, body: '1|OK' });
    expect(p.acknowledgeCallback({ accepted: false })).toMatchObject({ statusCode: 500, body: '0|FAIL' });
  });

  it('reports only offline configuration health and never claims ECPay connectivity', async () => {
    const { provider: p } = provider();
    const result = await p.healthCheck!();
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain('offline configuration verified');
    expect(result.message).toContain('callback delivery require UAT');
    expect(result.message).not.toContain(secrets.ECPAY_HASH_KEY);
    expect(result.message).not.toContain(secrets.ECPAY_HASH_IV);
  });

  it('does not invent a refund transport before the merchant capability is confirmed', async () => {
    const { provider: p } = provider();
    await expect(p.refund({ providerRef: '2408241234567890', amountCents: 10_000, currency: 'TWD', reference: 'refund:test:attempt:1' }))
      .resolves.toEqual({ status: 'unsupported', message: expect.stringMatching(/UAT contract/) });
  });
});
