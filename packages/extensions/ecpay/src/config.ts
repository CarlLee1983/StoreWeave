import { z } from 'zod';

export const ECPAY_MERCHANT_ID_SECRET = 'ECPAY_MERCHANT_ID';
export const ECPAY_HASH_KEY_SECRET = 'ECPAY_HASH_KEY';
export const ECPAY_HASH_IV_SECRET = 'ECPAY_HASH_IV';
/** Required only when the explicitly enabled credit-card refund capability queries ECPay. */
export const ECPAY_CREDIT_CHECK_CODE_SECRET = 'ECPAY_CREDIT_CHECK_CODE';

export const ECPAY_STAGE_CHECKOUT_URL = 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5';
export const ECPAY_PRODUCTION_CHECKOUT_URL = 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5';
export const ECPAY_CREDIT_REFUND_ACTION_URL = 'https://payment.ecpay.com.tw/CreditDetail/DoAction';
export const ECPAY_CREDIT_REFUND_QUERY_URL = 'https://payment.ecpay.com.tw/CreditDetail/QueryTrade/V2';
export const ECPAY_CREDIT_REFUND_ALLOWED_HOSTS = ['payment.ecpay.com.tw'] as const;

/** Store-facing method codes; ECPay-specific values stay in the provider. */
export const ecpayEnabledMethodSchema = z.enum(['card', 'atm', 'cvs_code', 'cvs_barcode']);
export type EcpayPaymentMethodCode = z.infer<typeof ecpayEnabledMethodSchema>;

/** Configuration deliberately contains URLs and presentation values only. Credentials are required secrets. */
const deferredMethodCodes = new Set<EcpayPaymentMethodCode>(['atm', 'cvs_code', 'cvs_barcode']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * ECPay calls these URLs from outside the store network. DNS, TLS and ingress
 * reachability still need UAT, but accepting a non-HTTPS or credential-bearing
 * URL here would make a known-bad release configuration look valid.
 */
const ecpayPublicHttpsUrl = z.string().url().max(200).superRefine((value, context) => {
  const url = parseUrl(value);
  // `z.string().url()` above reports malformed input. Do not turn that expected
  // validation failure into an exception while checking the release constraints.
  if (!url) return;
  if (url.protocol !== 'https:') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must use https' });
  }
  if (url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain URL credentials' });
  }
  if (url.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain a URL fragment' });
  }
});

const ecpayCallbackUrl = ecpayPublicHttpsUrl.superRefine((value, context) => {
  if (parseUrl(value)?.search) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain query parameters' });
  }
});

const enabledMethodsSchema = z.array(ecpayEnabledMethodSchema).min(1).superRefine((methods, context) => {
  const duplicate = methods.find((method, index) => methods.indexOf(method) !== index);
  if (duplicate) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must not contain duplicate payment method: ${duplicate}`,
    });
  }
});

export const ecpayPaymentConfig = z.object({
  environment: z.enum(['stage', 'production']).default('stage'),
  /** ECPay's server-to-server payment-result callback URL. */
  returnUrl: ecpayCallbackUrl,
  /** Required for deferred methods; it receives ATM/CVS/BARCODE payment instructions. */
  paymentInfoUrl: ecpayCallbackUrl.optional(),
  /** Optional customer-facing return link displayed by ECPay. */
  clientBackUrl: ecpayPublicHttpsUrl.optional(),
  /** Methods that this store deliberately offers at checkout. */
  enabledMethods: enabledMethodsSchema.default(['card']),
  itemName: z.string().min(1).max(400).default('StoreWeave order'),
  tradeDescription: z.string().min(1).max(200).default('StoreWeave order payment'),
  /**
   * The documented legacy credit-refund APIs are production-only. Keep them
   * explicitly disabled until merchant entitlement and UAT evidence are ready.
   */
  creditRefund: z.object({
    /** Locks this adapter to the documented legacy AIO product, never POS. */
    mode: z.enum(['disabled', 'aio-production']).default('disabled'),
    /** ECPay asks callers that receive 403 to wait at least 30 minutes. */
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  }).strict().default({ mode: 'disabled', timeoutMs: 10_000 }),
}).strict().superRefine((config, context) => {
  if (config.enabledMethods.some((method) => deferredMethodCodes.has(method)) && !config.paymentInfoUrl) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['paymentInfoUrl'],
      message: 'paymentInfoUrl is required when ATM, CVS, or BARCODE payment methods are enabled',
    });
  }
  if (config.creditRefund.mode === 'aio-production' && config.environment !== 'production') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['creditRefund', 'mode'], message: 'aio-production requires the production environment because ECPay credit refunds cannot use Stage' });
  }
  if (config.creditRefund.mode === 'aio-production' && !config.enabledMethods.includes('card')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['creditRefund', 'mode'], message: 'aio-production requires the card payment method so ECPay can return the credit refund identifier' });
  }
});

export type EcpayPaymentConfig = z.infer<typeof ecpayPaymentConfig>;

export function checkoutUrl(config: EcpayPaymentConfig): string {
  return config.environment === 'production' ? ECPAY_PRODUCTION_CHECKOUT_URL : ECPAY_STAGE_CHECKOUT_URL;
}
