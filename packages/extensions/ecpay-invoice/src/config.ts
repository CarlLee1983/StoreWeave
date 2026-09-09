import { z } from 'zod';

export const ECPAY_INVOICE_MERCHANT_ID_SECRET = 'ECPAY_INVOICE_MERCHANT_ID';
export const ECPAY_INVOICE_HASH_KEY_SECRET = 'ECPAY_INVOICE_HASH_KEY';
export const ECPAY_INVOICE_HASH_IV_SECRET = 'ECPAY_INVOICE_HASH_IV';

export const ECPAY_INVOICE_STAGE_BASE_URL = 'https://einvoice-stage.ecpay.com.tw';
export const ECPAY_INVOICE_PRODUCTION_BASE_URL = 'https://einvoice.ecpay.com.tw';

/** Invoice credentials are intentionally separate from AIO payment credentials. */
export const ecpayInvoiceConfig = z.object({
  environment: z.enum(['stage', 'production']).default('stage'),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
}).strict();
export type EcpayInvoiceConfig = z.infer<typeof ecpayInvoiceConfig>;
export function invoiceBaseUrl(config: EcpayInvoiceConfig): string { return config.environment === 'production' ? ECPAY_INVOICE_PRODUCTION_BASE_URL : ECPAY_INVOICE_STAGE_BASE_URL; }

/** 只准連往這兩個 ECPay 主機；轉址到別處一律拒絕。 */
export const ECPAY_INVOICE_ALLOWED_HOSTS = [
  new URL(ECPAY_INVOICE_STAGE_BASE_URL).hostname,
  new URL(ECPAY_INVOICE_PRODUCTION_BASE_URL).hostname,
] as const;
