import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import type { ExtensionContext, InvoiceCarrier, InvoiceIssueInput, InvoiceIssueResult, InvoiceProvider, InvoiceVoidInput, InvoiceVoidResult } from '@storeweave/extension-sdk';
import { ECPAY_INVOICE_HASH_IV_SECRET, ECPAY_INVOICE_HASH_KEY_SECRET, ECPAY_INVOICE_MERCHANT_ID_SECRET, invoiceBaseUrl, type EcpayInvoiceConfig } from './config';

export const ECPAY_INVOICE_PROVIDER_ID = 'ecpay';
type ApiData = Record<string, unknown> & { RtnCode?: number | string; RtnMsg?: string };

export function createEcpayInvoiceProvider(ctx: ExtensionContext<EcpayInvoiceConfig>): InvoiceProvider {
  const credentials = requiredCredentials(ctx);
  const call = (path: string, data: Record<string, unknown>) => ecpayCall(ctx, credentials, path, data);
  return {
    id: ECPAY_INVOICE_PROVIDER_ID,
    kind: 'invoice',
    async validateLoveCode(loveCode: string): Promise<boolean> {
      const data = await call('/B2CInvoice/CheckLoveCode', { MerchantID: credentials.merchantId, LoveCode: loveCode });
      return String(data.RtnCode) === '1' && data.IsExist === 'Y';
    },
    async issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult> {
      if (input.currency !== 'TWD' || input.amountCents % 100 !== 0) return { status: 'rejected', message: 'ECPay B2C invoices require a whole-TWD amount' };
      const carrier = carrierFields(input.carrier);
      const data = await call('/B2CInvoice/Issue', {
        MerchantID: credentials.merchantId, RelateNumber: relateNumber(input.reference), CustomerID: '', CustomerIdentifier: '',
        CustomerName: input.customer.name, CustomerAddr: '', CustomerPhone: digitsOnly(input.customer.phone), CustomerEmail: input.customer.email,
        ClearanceMark: '', Print: '0', ...carrier, TaxType: '1', SalesAmount: input.amountCents / 100, InvoiceRemark: '', InvType: '07', vat: '1',
        Items: input.lines.map((line, index) => ({ ItemSeq: index + 1, ItemName: line.name, ItemCount: line.quantity, ItemWord: '件', ItemPrice: line.unitPriceCents / 100, ItemTaxType: '1', ItemAmount: line.amountCents / 100, ItemRemark: '' })),
      });
      if (String(data.RtnCode) !== '1' || typeof data.InvoiceNo !== 'string' || typeof data.InvoiceDate !== 'string') return { status: 'rejected', message: apiMessage(data) };
      return { status: 'issued', providerRef: data.InvoiceNo, invoiceNumber: data.InvoiceNo, invoiceDate: data.InvoiceDate };
    },
    async void(input: InvoiceVoidInput): Promise<InvoiceVoidResult> {
      const data = await call('/B2CInvoice/Invalid', { MerchantID: credentials.merchantId, InvoiceNo: input.invoiceNumber, InvoiceDate: input.invoiceDate.slice(0, 10), Reason: input.reason.slice(0, 20) });
      if (String(data.RtnCode) !== '1') return { status: 'rejected', message: apiMessage(data) };
      return { status: 'voided', providerRef: typeof data.InvoiceNo === 'string' ? data.InvoiceNo : input.providerRef };
    },
    async healthCheck() { return { ok: true, message: `ECPay invoice ${ctx.config.environment} configuration verified; use Stage UAT for upstream evidence` }; },
  };
}

function requiredCredentials(ctx: ExtensionContext<EcpayInvoiceConfig>) {
  const merchantId = ctx.secret(ECPAY_INVOICE_MERCHANT_ID_SECRET); const hashKey = ctx.secret(ECPAY_INVOICE_HASH_KEY_SECRET); const hashIv = ctx.secret(ECPAY_INVOICE_HASH_IV_SECRET);
  if (!merchantId || !hashKey || !hashIv) throw new Error('ECPay invoice credentials are not available from required secrets');
  if (Buffer.byteLength(hashKey) !== 16 || Buffer.byteLength(hashIv) !== 16) throw new Error('ECPay invoice HashKey and HashIV must each be 16 bytes for AES-128-CBC');
  return { merchantId, hashKey, hashIv };
}

async function ecpayCall(ctx: ExtensionContext<EcpayInvoiceConfig>, credentials: { merchantId: string; hashKey: string; hashIv: string }, path: string, payload: Record<string, unknown>): Promise<ApiData> {
  const response = await fetch(`${invoiceBaseUrl(ctx.config)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ MerchantID: credentials.merchantId, RqHeader: { Timestamp: Math.floor(ctx.now().getTime() / 1000) }, Data: encrypt(payload, credentials) }) });
  if (!response.ok) throw new Error(`ECPay invoice ${path} returned HTTP ${response.status}`);
  const outer = await response.json() as { TransCode?: number | string; TransMsg?: string; Data?: string };
  if (String(outer.TransCode) !== '1' || !outer.Data) return { RtnCode: outer.TransCode, RtnMsg: outer.TransMsg ?? 'ECPay rejected invoice transport' };
  return decrypt(outer.Data, credentials);
}

function encrypt(value: Record<string, unknown>, credentials: { hashKey: string; hashIv: string }): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(credentials.hashKey), Buffer.from(credentials.hashIv));
  return Buffer.concat([cipher.update(encodeURIComponent(JSON.stringify(value)), 'utf8'), cipher.final()]).toString('base64');
}
function decrypt(value: string, credentials: { hashKey: string; hashIv: string }): ApiData {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(credentials.hashKey), Buffer.from(credentials.hashIv));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(decodeURIComponent(plaintext)) as ApiData;
}
function relateNumber(reference: string): string { return `SW${createHash('sha256').update(reference).digest('hex').slice(0, 28).toUpperCase()}`; }
function digitsOnly(value: string): string { return value.replace(/\D/g, ''); }
function apiMessage(data: ApiData): string { return typeof data.RtnMsg === 'string' && data.RtnMsg ? data.RtnMsg : `ECPay invoice RtnCode ${String(data.RtnCode ?? 'unknown')}`; }
function carrierFields(carrier: InvoiceCarrier): Record<string, string> {
  switch (carrier.kind) {
    case 'ecpay': return { Donation: '0', LoveCode: '', CarrierType: '1', CarrierNum: '' };
    case 'mobile': return { Donation: '0', LoveCode: '', CarrierType: '3', CarrierNum: carrier.number };
    case 'natural_person': return { Donation: '0', LoveCode: '', CarrierType: '2', CarrierNum: carrier.number };
    case 'donation': return { Donation: '1', LoveCode: carrier.loveCode, CarrierType: '', CarrierNum: '' };
  }
}

export const __private__ = { encrypt, decrypt, relateNumber, carrierFields };
