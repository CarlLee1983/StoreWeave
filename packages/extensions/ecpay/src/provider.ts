import { createHash } from 'node:crypto';
import type {
  ExtensionContext,
  PaymentCallbackAcknowledgement,
  PaymentCallbackEvent,
  PaymentCallbackHandlingResult,
  PaymentCallbackRequest,
  PaymentInitiationInput,
  PaymentInitiationResult,
  PaymentInfoIssuedCallback,
  PaymentMethod,
  PaymentProviderV2,
  PaymentRefundInputV2,
  PaymentRefundResult,
} from '@storeweave/extension-sdk';
import { paymentInitiationInputSchema } from '@storeweave/extension-sdk';
import { createCheckMacValue, verifyCheckMacValue, type EcpayFields } from './check-mac-value';
import {
  checkoutUrl,
  ECPAY_HASH_IV_SECRET,
  ECPAY_HASH_KEY_SECRET,
  ECPAY_MERCHANT_ID_SECRET,
  type EcpayPaymentConfig,
  type EcpayPaymentMethodCode,
} from './config';

export const ECPAY_PAYMENT_PROVIDER_ID = 'ecpay';

interface TradeRecord {
  readonly reference: string;
  readonly amountTwd: number;
  readonly merchantTradeNo: string;
  readonly method: EcpayPaymentMethodCode;
  /** Form signatures include this value, so retries must reuse it exactly. */
  readonly merchantTradeDate: string;
  /** Added during SW-115; absent on records created by the legacy adapter. */
  readonly facts?: PaymentInitiationInput;
}

interface InitiationOutcome {
  readonly result: PaymentInitiationResult;
  readonly record?: TradeRecord;
}

interface EcpayMethod extends PaymentMethod {
  readonly code: EcpayPaymentMethodCode;
  readonly ecpayChoosePayment: string;
}

const METHODS: Readonly<Record<EcpayPaymentMethodCode, EcpayMethod>> = {
  card: { code: 'card', label: 'Credit card', timing: 'immediate', ecpayChoosePayment: 'Credit' },
  atm: { code: 'atm', label: 'ATM transfer', timing: 'deferred', ecpayChoosePayment: 'ATM' },
  cvs_code: { code: 'cvs_code', label: 'Convenience store code', timing: 'deferred', ecpayChoosePayment: 'CVS' },
  cvs_barcode: { code: 'cvs_barcode', label: 'Convenience store barcode', timing: 'deferred', ecpayChoosePayment: 'BARCODE' },
};

export function createEcpayPaymentProvider(ctx: ExtensionContext<EcpayPaymentConfig>): PaymentProviderV2 {
  const credentials = requiredCredentials(ctx);
  const createRedirect = (record: TradeRecord): PaymentInitiationResult => {
    const fields: Record<string, string> = {
      MerchantID: credentials.merchantId,
      MerchantTradeNo: record.merchantTradeNo,
      MerchantTradeDate: record.merchantTradeDate,
      PaymentType: 'aio',
      TotalAmount: String(record.amountTwd),
      TradeDesc: ctx.config.tradeDescription,
      ItemName: ctx.config.itemName,
      ReturnURL: ctx.config.returnUrl,
      ChoosePayment: METHODS[record.method].ecpayChoosePayment,
      EncryptType: '1',
    };
    if (ctx.config.paymentInfoUrl) fields.PaymentInfoURL = ctx.config.paymentInfoUrl;
    if (ctx.config.clientBackUrl) fields.ClientBackURL = ctx.config.clientBackUrl;
    fields.CheckMacValue = createCheckMacValue(fields, credentials.hashKey, credentials.hashIv);
    return { status: 'redirect', providerRef: record.merchantTradeNo, action: { type: 'form_post', url: checkoutUrl(ctx.config), fields } };
  };

  async function initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult> {
    const valid = paymentInitiationInputSchema.safeParse(input);
    if (!valid.success) {
      return { status: 'failed', reason: 'provider_rejected', message: 'invalid payment initiation input' };
    }
    return (await initiateNeutral(valid.data)).result;
  }

  async function initiateNeutral(input: PaymentInitiationInput): Promise<InitiationOutcome> {
    const key = referenceKey(input.reference);
    const existingBeforeMutation = await ctx.store.get<TradeRecord>(key);
    if (!existingBeforeMutation) {
      const failureMessage = capabilityFailure(input, ctx.config.enabledMethods);
      if (failureMessage) {
        return { result: { status: 'failed', reason: 'provider_rejected', message: failureMessage } };
      }
    }
    let outcome: InitiationOutcome | undefined;
    await ctx.store.mutate<TradeRecord | null>(key, (existing) => {
      if (existing) {
        if (existing.facts) {
          if (!sameInitiation(existing.facts, input)) {
            outcome = { result: referenceConflict(existing) };
            return existing;
          }
          outcome = { result: createRedirect(existing), record: existing };
          return existing;
        }

        // Legacy records do not contain a display reference. Adopt that one
        // missing fact only after the fields the old record does prove match.
        if (!sameLegacyKnownFacts(existing, input)) {
          outcome = { result: referenceConflict(existing) };
          return existing;
        }
        const adopted = { ...existing, facts: input };
        outcome = { result: createRedirect(adopted), record: adopted };
        return adopted;
      }

      const failureMessage = capabilityFailure(input, ctx.config.enabledMethods);
      if (failureMessage) {
        outcome = { result: { status: 'failed', reason: 'provider_rejected', message: failureMessage } };
        return null;
      }
      const record: TradeRecord = {
        reference: input.reference,
        amountTwd: input.amount / 100,
        merchantTradeNo: merchantTradeNo(input.reference),
        method: input.method as EcpayPaymentMethodCode,
        merchantTradeDate: formatEcpayDate(ctx.now()),
        facts: input,
      };
      outcome = { result: createRedirect(record), record };
      return record;
    });

    if (!outcome) throw new Error('ECPay payment store did not produce an initiation outcome');
    if (outcome.record && outcome.result.status === 'redirect') {
      const collision = await reserveTradeMapping(outcome.record);
      if (collision) {
        return {
          result: { status: 'failed', reason: 'provider_rejected', message: 'ECPay trade reference is already associated with another payment' },
        };
      }
    }
    return outcome;
  }

  async function reserveTradeMapping(record: TradeRecord): Promise<boolean> {
    let collision = false;
    await ctx.store.mutate<TradeRecord | null>(tradeKey(record.merchantTradeNo), (current) => {
      if (current && current.reference !== record.reference) {
        collision = true;
        return current;
      }
      return record;
    });
    return collision;
  }

  return {
    id: ECPAY_PAYMENT_PROVIDER_ID,
    kind: 'payment',

    paymentMethods(): readonly PaymentMethod[] {
      return ctx.config.enabledMethods.map((code) => {
        const { ecpayChoosePayment: _vendorValue, ...method } = METHODS[code];
        return method;
      });
    },

    initiate,

    async parseCallback(request: PaymentCallbackRequest): Promise<PaymentCallbackEvent> {
      const fields = parseForm(request.body);
      if (!verifyCheckMacValue(fields, credentials.hashKey, credentials.hashIv)) throw new Error('ECPay callback CheckMacValue is invalid');
      if (fields.MerchantID !== credentials.merchantId) throw new Error('ECPay callback MerchantID does not match configured merchant');
      const merchantTradeNo = requiredField(fields, 'MerchantTradeNo');
      const record = await ctx.store.get<TradeRecord>(tradeKey(merchantTradeNo));
      if (!record) throw new Error('ECPay callback is not associated with a started payment');
      if (fields.TradeAmt !== undefined && Number(fields.TradeAmt) !== record.amountTwd) throw new Error('ECPay callback amount does not match started payment');

      const providerRef = fields.TradeNo || merchantTradeNo;
      const paymentInfo = paymentInfoEvent(fields, record, providerRef);
      if (paymentInfo) return paymentInfo;
      if (fields.RtnCode === '1') return { type: 'payment_confirmed', reference: record.reference, providerRef };
      return { type: 'payment_failed', reference: record.reference, providerRef, message: fields.RtnMsg || `ECPay RtnCode ${requiredField(fields, 'RtnCode')}` };
    },

    acknowledgeCallback(result: PaymentCallbackHandlingResult): PaymentCallbackAcknowledgement {
      // ECPay retries until it receives this exact acknowledgement. Only send it
      // after the platform has durably accepted (including duplicate) the event.
      return result.accepted || result.duplicate
        ? { statusCode: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '1|OK' }
        : { statusCode: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '0|FAIL' };
    },

    async refund(_input: PaymentRefundInputV2): Promise<PaymentRefundResult> {
      // Ticket 58 has not yet established which refund/query product this
      // merchant account can use. Keep the local refund requested and stop the
      // job permanently rather than inventing an endpoint or moving money facts.
      return { status: 'unsupported' as const, message: 'ECPay refund automation is unavailable until the merchant refund product and UAT contract are confirmed' };
    },

    async healthCheck() {
      // This intentionally does not call ECPay. There is no confirmed, side-effect
      // free endpoint that can prove a merchant account or callback ingress works.
      // The release runbook treats DNS/TLS, callback delivery and payment UAT as
      // external gates rather than allowing this local check to overclaim.
      return {
        ok: true,
        message: `ECPay ${ctx.config.environment} offline configuration verified (methods: ${ctx.config.enabledMethods.join(', ')}; upstream connectivity and callback delivery require UAT)`,
      };
    },
  };
}

function capabilityFailure(input: PaymentInitiationInput, enabledMethods: readonly EcpayPaymentMethodCode[]): string | null {
  const selectedMethod = METHODS[input.method as EcpayPaymentMethodCode];
  if (!selectedMethod) return `Unsupported ECPay payment method: ${input.method}`;
  if (!enabledMethods.includes(selectedMethod.code)) return `ECPay payment method is not enabled: ${input.method}`;
  if (input.currency !== 'TWD') return 'ECPay AIO accepts TWD only';
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount % 100 !== 0) {
    return 'TWD amount must be a positive whole New Taiwan dollar';
  }
  return null;
}

function sameInitiation(left: PaymentInitiationInput, right: PaymentInitiationInput): boolean {
  return left.reference === right.reference &&
    left.displayReference === right.displayReference &&
    left.amount === right.amount &&
    left.currency === right.currency &&
    left.method === right.method;
}

function sameLegacyKnownFacts(record: TradeRecord, input: PaymentInitiationInput): boolean {
  return record.reference === input.reference &&
    input.amount === record.amountTwd * 100 &&
    input.currency === 'TWD' &&
    input.method === record.method;
}

function referenceConflict(record: TradeRecord): PaymentInitiationResult {
  return {
    status: 'failed',
    reason: 'reference_conflict',
    providerRef: record.merchantTradeNo,
    message: 'reference is already used for different payment facts',
  };
}

function requiredCredentials(ctx: ExtensionContext<EcpayPaymentConfig>) {
  const merchantId = ctx.secret(ECPAY_MERCHANT_ID_SECRET);
  const hashKey = ctx.secret(ECPAY_HASH_KEY_SECRET);
  const hashIv = ctx.secret(ECPAY_HASH_IV_SECRET);
  if (!merchantId || !hashKey || !hashIv) throw new Error('ECPay credentials are not available from required secrets');
  return { merchantId, hashKey, hashIv };
}

function merchantTradeNo(reference: string): string {
  // ECPay accepts at most 20 alphanumeric characters. Hashing keeps arbitrary
  // platform idempotency references within that constraint without leaking them.
  return `SW${createHash('sha256').update(reference).digest('hex').slice(0, 18).toUpperCase()}`;
}

function referenceKey(reference: string) { return `ecpay:reference:${reference}`; }
function tradeKey(merchantTradeNo: string) { return `ecpay:trade:${merchantTradeNo}`; }

function formatEcpayDate(date: Date): string {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce<Record<string, string>>((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${local.year}/${local.month}/${local.day} ${local.hour}:${local.minute}:${local.second}`;
}

function parseForm(body: Uint8Array): EcpayFields {
  const params = new URLSearchParams(Buffer.from(body).toString('utf8'));
  const fields: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) throw new Error(`ECPay callback repeats field "${key}"`);
    fields[key] = value;
  }
  return fields;
}

function requiredField(fields: EcpayFields, field: string): string {
  const value = fields[field];
  if (!value) throw new Error(`ECPay callback is missing ${field}`);
  return value;
}

function paymentInfoEvent(fields: EcpayFields, record: TradeRecord, providerRef: string): PaymentInfoIssuedCallback | null {
  const expectedSuccessCode = paymentInfoSuccessCode(record.method);
  // ECPay includes the same instruction fields in some failed result payloads.
  // They are not proof that a usable payment number was issued.
  if (!expectedSuccessCode || fields.RtnCode !== expectedSuccessCode) return null;
  const instructions = [
    fields.BankCode && { label: 'Bank code', value: fields.BankCode },
    fields.vAccount && { label: 'Virtual account', value: fields.vAccount },
    fields.PaymentNo && { label: 'Payment number', value: fields.PaymentNo },
    fields.Barcode1 && { label: 'Barcode 1', value: fields.Barcode1 },
    fields.Barcode2 && { label: 'Barcode 2', value: fields.Barcode2 },
    fields.Barcode3 && { label: 'Barcode 3', value: fields.Barcode3 },
  ].filter((entry): entry is { label: string; value: string } => Boolean(entry));
  const expiresAt = fields.ExpireDate && parseExpiry(fields.ExpireDate);
  return instructions.length > 0 && expiresAt
    ? { type: 'payment_info_issued', reference: record.reference, providerRef, instructions, expiresAt }
    : null;
}

function paymentInfoSuccessCode(method: EcpayPaymentMethodCode): string | null {
  if (method === 'atm') return '2';
  if (method === 'cvs_code' || method === 'cvs_barcode') return '10100073';
  return null;
}

function parseExpiry(value: string): string | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText = '23', minuteText = '59', secondText = '59'] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const validationDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    validationDate.getUTCFullYear() !== year || validationDate.getUTCMonth() !== month - 1 || validationDate.getUTCDate() !== day ||
    validationDate.getUTCHours() !== hour || validationDate.getUTCMinutes() !== minute || validationDate.getUTCSeconds() !== second
  ) return null;
  const date = new Date(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
