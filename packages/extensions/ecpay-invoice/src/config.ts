import { z } from 'zod';

export const ECPAY_INVOICE_MERCHANT_ID_SECRET = 'ECPAY_INVOICE_MERCHANT_ID';
export const ECPAY_INVOICE_HASH_KEY_SECRET = 'ECPAY_INVOICE_HASH_KEY';
export const ECPAY_INVOICE_HASH_IV_SECRET = 'ECPAY_INVOICE_HASH_IV';

export const ECPAY_INVOICE_STAGE_BASE_URL = 'https://einvoice-stage.ecpay.com.tw';
export const ECPAY_INVOICE_PRODUCTION_BASE_URL = 'https://einvoice.ecpay.com.tw';

/** Invoice credentials are intentionally separate from AIO payment credentials. */
export const ecpayInvoiceConfig = z.object({ environment: z.enum(['stage', 'production']).default('stage') }).strict();
export type EcpayInvoiceConfig = z.infer<typeof ecpayInvoiceConfig>;
export function invoiceBaseUrl(config: EcpayInvoiceConfig): string { return config.environment === 'production' ? ECPAY_INVOICE_PRODUCTION_BASE_URL : ECPAY_INVOICE_STAGE_BASE_URL; }
