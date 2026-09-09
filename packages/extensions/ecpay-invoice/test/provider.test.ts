import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestExtensionContext } from '@storeweave/extension-sdk';
import { __private__, createEcpayInvoiceProvider, ecpayInvoiceConfig } from '../src';

const secrets = { ECPAY_INVOICE_MERCHANT_ID: '2000132', ECPAY_INVOICE_HASH_KEY: '1234567890123456', ECPAY_INVOICE_HASH_IV: '6543210987654321' };
const credentials = { merchantId: secrets.ECPAY_INVOICE_MERCHANT_ID, hashKey: secrets.ECPAY_INVOICE_HASH_KEY, hashIv: secrets.ECPAY_INVOICE_HASH_IV };
const issueInput = { invoiceId: '11111111-1111-4111-8111-111111111111', reference: 'invoice:11111111-1111-4111-8111-111111111111', orderId: '22222222-2222-4222-8222-222222222222', orderNumber: 'SW-1000', currency: 'TWD', amountCents: 10_500, taxCents: 500, customer: { email: 'customer@example.test', name: 'Test Customer', phone: '0912345678' }, carrier: { kind: 'mobile' as const, number: '/ABC1234' }, lines: [{ name: 'T-shirt × 1', quantity: 1, unitPriceCents: 10_500, amountCents: 10_500 }] };

function provider(fetchStub?: typeof fetch) {
  return createEcpayInvoiceProvider(createTestExtensionContext({
    extensionId: 'ecpay-invoice', config: ecpayInvoiceConfig.parse({ environment: 'stage' }), secrets,
    now: () => new Date('2026-08-25T10:00:00.000Z'),
    // 測試情境不再回退到全域 fetch：替身必須明確傳進來，忘了給就會失敗而不是打真網路。
    ...(fetchStub ? { fetch: fetchStub } : {}),
  }));
}
function encryptedResponse(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ TransCode: 1, Data: __private__.encrypt(data, credentials) }), { status: 200, headers: { 'content-type': 'application/json' } });
}
afterEach(() => vi.unstubAllGlobals());

describe('ECPay B2C invoice provider', () => {
  it('encrypts the documented tax-inclusive issue payload and normalizes an issued result', async () => {
    const request = vi.fn(async () => encryptedResponse({ RtnCode: 1, RtnMsg: 'issued', InvoiceNo: 'AB12345678', InvoiceDate: '2026-08-25 18:00:00' }));
    await expect(provider(request as unknown as typeof fetch).issue(issueInput)).resolves.toEqual({ status: 'issued', providerRef: 'AB12345678', invoiceNumber: 'AB12345678', invoiceDate: '2026-08-25 18:00:00' });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://einvoice-stage.ecpay.com.tw/B2CInvoice/Issue');
    const outer = JSON.parse(String(init.body));
    const data = __private__.decrypt(outer.Data, credentials);
    expect(data).toMatchObject({ MerchantID: '2000132', TaxType: '1', SalesAmount: 105, vat: '1', Print: '0', Donation: '0', CarrierType: '3', CarrierNum: '/ABC1234' });
    expect(data.RelateNumber).toMatch(/^SW[A-F0-9]{28}$/);
    expect(data.Items).toEqual([expect.objectContaining({ ItemPrice: 105, ItemAmount: 105, ItemTaxType: '1' })]);
  });

  it('checks a donation love code before issuance and maps carrier choices exactly', async () => {
    const request = vi.fn(async () => encryptedResponse({ RtnCode: 1, IsExist: 'Y' }));
    await expect(provider(request as unknown as typeof fetch).validateLoveCode('168001')).resolves.toBe(true);
    expect(__private__.carrierFields({ kind: 'ecpay' })).toEqual({ Donation: '0', LoveCode: '', CarrierType: '1', CarrierNum: '' });
    expect(__private__.carrierFields({ kind: 'natural_person', number: 'AB12345678901234' })).toEqual({ Donation: '0', LoveCode: '', CarrierType: '2', CarrierNum: 'AB12345678901234' });
    expect(__private__.carrierFields({ kind: 'donation', loveCode: '168001' })).toEqual({ Donation: '1', LoveCode: '168001', CarrierType: '', CarrierNum: '' });
  });

  it('uses the B2C Invalid endpoint with an invoice date only for a void', async () => {
    const request = vi.fn(async () => encryptedResponse({ RtnCode: 1, InvoiceNo: 'AB12345678' }));
    await expect(provider(request as unknown as typeof fetch).void({ invoiceId: issueInput.invoiceId, reference: 'void:invoice', providerRef: 'AB12345678', invoiceNumber: 'AB12345678', invoiceDate: '2026-08-25 18:00:00', reason: 'full refund' })).resolves.toEqual({ status: 'voided', providerRef: 'AB12345678' });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://einvoice-stage.ecpay.com.tw/B2CInvoice/Invalid');
    expect(__private__.decrypt(JSON.parse(String(init.body)).Data, credentials)).toMatchObject({ InvoiceNo: 'AB12345678', InvoiceDate: '2026-08-25', Reason: 'full refund' });
  });

  it('keeps credentials out of configuration and rejects non-AES credential lengths', () => {
    expect(() => ecpayInvoiceConfig.parse({ merchantId: 'never-in-config' })).toThrow(/unrecognized/i);
    expect(() => createEcpayInvoiceProvider(createTestExtensionContext({ extensionId: 'ecpay-invoice', config: ecpayInvoiceConfig.parse({}), secrets: { ...secrets, ECPAY_INVOICE_HASH_KEY: 'short' } }))).toThrow(/16 bytes/);
  });
});
