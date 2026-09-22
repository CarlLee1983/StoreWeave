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
import { paymentInitiationInputSchema, paymentRefundInputSchema } from '@storeweave/extension-sdk';
import { createCheckMacValue, verifyCheckMacValue, type EcpayFields } from './check-mac-value';
import {
  checkoutUrl,
  ECPAY_CREDIT_CHECK_CODE_SECRET,
  ECPAY_CREDIT_REFUND_ACTION_URL,
  ECPAY_CREDIT_REFUND_ALLOWED_HOSTS,
  ECPAY_CREDIT_REFUND_QUERY_URL,
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

interface ConfirmedCardRecord {
  readonly trade: TradeRecord;
  readonly providerRef: string;
  readonly creditRefundId?: string;
}

type RefundState = 'checking' | 'follow_up' | 'succeeded' | 'rejected' | 'indeterminate';
interface RefundRecord {
  readonly request: PaymentRefundInputV2;
  readonly payment: ConfirmedCardRecord;
  readonly state: RefundState;
  readonly result?: PaymentRefundResult;
  readonly lastAction?: 'E';
}

interface CreditQuery {
  readonly status: string;
  readonly amount: number;
  readonly closeData: readonly { readonly status: string; readonly amount: number }[];
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
  const creditRefundEnabled = ctx.config.creditRefund.mode === 'aio-production';
  const creditCheckCode = creditRefundEnabled ? ctx.secret(ECPAY_CREDIT_CHECK_CODE_SECRET) : undefined;
  if (creditRefundEnabled && !creditCheckCode) throw new Error('ECPay credit refunds require the configured CreditCheckCode secret');
  const createRedirect = (record: TradeRecord): PaymentInitiationResult => {
    const requestFields: Record<string, string> = {
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
    if (ctx.config.paymentInfoUrl) requestFields.PaymentInfoURL = ctx.config.paymentInfoUrl;
    if (ctx.config.clientBackUrl) requestFields.ClientBackURL = ctx.config.clientBackUrl;
    if (creditRefundEnabled && record.method === 'card') requestFields.NeedExtraPaidInfo = 'Y';
    requestFields.CheckMacValue = createCheckMacValue(requestFields, credentials.hashKey, credentials.hashIv);
    return { status: 'redirect', providerRef: record.merchantTradeNo, action: { type: 'form_post', url: checkoutUrl(ctx.config), fields: requestFields } };
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
      if (fields.RtnCode === '1') {
        await recordConfirmedCard(fields, record, providerRef);
        return { type: 'payment_confirmed', reference: record.reference, providerRef };
      }
      return { type: 'payment_failed', reference: record.reference, providerRef, message: fields.RtnMsg || `ECPay RtnCode ${requiredField(fields, 'RtnCode')}` };
    },

    acknowledgeCallback(result: PaymentCallbackHandlingResult): PaymentCallbackAcknowledgement {
      // ECPay retries until it receives this exact acknowledgement. Only send it
      // after the platform has durably accepted (including duplicate) the event.
      return result.accepted || result.duplicate
        ? { statusCode: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '1|OK' }
        : { statusCode: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '0|FAIL' };
    },

    async refund(input: PaymentRefundInputV2): Promise<PaymentRefundResult> {
      if (!creditRefundEnabled) return { status: 'unsupported', message: 'ECPay credit refunds are disabled until merchant entitlement and UAT are approved' };
      if (!creditCheckCode) return { status: 'unsupported', message: 'ECPay credit refunds require the configured CreditCheckCode secret' };
      const valid = paymentRefundInputSchema.safeParse(input);
      if (!valid.success) return { status: 'rejected', message: 'invalid ECPay refund input' };
      if (input.currency !== 'TWD' || input.amount % 100 !== 0) return { status: 'rejected', message: 'ECPay credit refunds require a positive whole-TWD amount' };

      const payment = await ctx.store.get<ConfirmedCardRecord>(providerRefKey(input.providerRef));
      if (!payment || payment.providerRef !== input.providerRef) return { status: 'rejected', message: 'ECPay confirmed card payment is unavailable for refund' };
      if (!payment.creditRefundId) return { status: 'unsupported', message: 'ECPay payment callback did not supply the credit refund identifier required for query' };
      if (input.amount > payment.trade.amountTwd * 100) return { status: 'rejected', message: 'ECPay refund amount exceeds the original payment' };

      let reserved = false;
      const reservation = await ctx.store.mutate<RefundRecord>(refundLedgerKey(payment.providerRef), (current) => {
        if (current) return current;
        reserved = true;
        return { request: input, payment, state: 'checking' };
      });
      if (!sameRefundInput(reservation.request, input)) return { status: 'rejected', message: 'ECPay payment already has a refund operation with different facts' };
      if (!reserved) return continueRefund(reservation, input, creditCheckCode);
      return performRefund(reservation, creditCheckCode);
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

  async function recordConfirmedCard(fields: EcpayFields, trade: TradeRecord, providerRef: string): Promise<void> {
    if (trade.method !== 'card') return;
    const key = providerRefKey(providerRef);
    await ctx.store.mutate<ConfirmedCardRecord | null>(key, (current) => {
      const next = { trade, providerRef, ...(fields.gwsr ? { creditRefundId: fields.gwsr } : {}) };
      if (current && (current.providerRef !== next.providerRef || current.creditRefundId !== next.creditRefundId || current.trade.merchantTradeNo !== next.trade.merchantTradeNo)) {
        throw new Error('ECPay callback conflicts with the recorded card payment');
      }
      return current ?? next;
    });
  }

  async function continueRefund(record: RefundRecord, input: PaymentRefundInputV2, creditCheckCode: string): Promise<PaymentRefundResult> {
    if (!sameRefundInput(record.request, input)) return { status: 'rejected', message: 'ECPay refund reference is already used for different facts' };
    if (record.result) return record.result;
    if (record.state === 'follow_up') {
      let claimed = false;
      const claimedRecord = await ctx.store.mutate<RefundRecord>(refundLedgerKey(record.payment.providerRef), (current) => {
        if (!current || current.result || current.state !== 'follow_up') return current ?? record;
        claimed = true;
        return { ...current, state: 'checking' };
      });
      if (!claimed) {
        if (claimedRecord.result) return claimedRecord.result;
        throw new Error('ECPay refund follow-up is indeterminate and requires reconciliation before another action');
      }
      let query: CreditQuery;
      try {
        query = await queryCredit(claimedRecord.payment, creditCheckCode);
      } catch (error) {
        await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...claimedRecord, state: 'follow_up' });
        throw error;
      }
      if (query.status === '操作取消') return finishAbandon(claimedRecord);
      await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...claimedRecord, state: 'follow_up' });
      throw new Error('ECPay refund follow-up is still pending and requires reconciliation before another action');
    } else {
      await queryCredit(record.payment, creditCheckCode);
    }
    // A duplicate caller, process interruption, or network uncertainty must not
    // make another DoAction request: public AIO docs give no idempotency key.
    throw new Error(`ECPay refund is indeterminate and requires reconciliation before another action (${record.state})`);
  }

  async function finishAbandon(record: RefundRecord): Promise<PaymentRefundResult> {
    let response: EcpayFields;
    try {
      response = await postRefundAction(record.payment, record.request.amount / 100, 'N');
    } catch (error) {
      await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'indeterminate' });
      throw error;
    }
    if (response.RtnCode !== '1') {
      const result: PaymentRefundResult = { status: 'rejected', message: response.RtnMsg || 'ECPay refund abandon action was rejected' };
      await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'rejected', result, lastAction: 'E' });
      return result;
    }
    const result: PaymentRefundResult = { status: 'succeeded', providerRefundRef: response.TradeNo || record.payment.providerRef, ...(response.RtnMsg ? { message: response.RtnMsg } : {}) };
    await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'succeeded', result, lastAction: 'E' });
    return result;
  }

  async function performRefund(record: RefundRecord, creditCheckCode: string): Promise<PaymentRefundResult> {
    let query: CreditQuery;
    try {
      query = await queryCredit(record.payment, creditCheckCode);
    } catch (error) {
      await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'indeterminate' });
      throw error;
    }
    const action = refundActionFor(query, record.request.amount / 100);
    if (action instanceof Error) {
      const result: PaymentRefundResult = { status: 'rejected', message: action.message };
      await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'rejected', result });
      return result;
    }
    await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'checking', ...(action === 'E' ? { lastAction: action } : {}) });
    let response: EcpayFields;
    try {
      response = await postRefundAction(record.payment, record.request.amount / 100, action);
    } catch (error) {
      await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'indeterminate', lastAction: action === 'E' ? action : record.lastAction });
      throw error;
    }
    if (response.RtnCode !== '1') {
      const result: PaymentRefundResult = { status: 'rejected', message: response.RtnMsg || `ECPay refund action ${action} was rejected` };
      await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'rejected', result, lastAction: action === 'E' ? action : record.lastAction });
      return result;
    }
    if (action === 'E') {
      await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'follow_up', lastAction: action });
      throw new Error('ECPay refund cancellation step completed; query reconciliation must confirm the follow-up abandon action');
    }
    const result: PaymentRefundResult = { status: 'succeeded', providerRefundRef: response.TradeNo || record.payment.providerRef, ...(response.RtnMsg ? { message: response.RtnMsg } : {}) };
    await ctx.store.set(refundLedgerKey(record.payment.providerRef), { ...record, state: 'succeeded', result, lastAction: record.lastAction });
    return result;
  }

  async function queryCredit(payment: ConfirmedCardRecord, creditCheckCode: string): Promise<CreditQuery> {
    const fields: Record<string, string> = {
      MerchantID: credentials.merchantId,
      CreditRefundId: payment.creditRefundId!,
      CreditAmount: String(payment.trade.amountTwd),
      CreditCheckCode: creditCheckCode,
    };
    fields.CheckMacValue = createCheckMacValue(fields, credentials.hashKey, credentials.hashIv);
    const http = ctx.http({ timeoutMs: ctx.config.creditRefund.timeoutMs, maxAttempts: 1, allowedHosts: ECPAY_CREDIT_REFUND_ALLOWED_HOSTS });
    const response = await http.requestJson<{ RtnMsg?: unknown; RtnValue?: unknown }>({ method: 'POST', url: ECPAY_CREDIT_REFUND_QUERY_URL, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    if (!response.ok) throw new Error(`ECPay credit refund query is indeterminate (${response.reason})`);
    const query = parseCreditQuery(response.body);
    if (!query) throw new Error('ECPay credit refund query is indeterminate (invalid response)');
    return query;
  }

  async function postRefundAction(payment: ConfirmedCardRecord, amountTwd: number, action: 'R' | 'E' | 'N'): Promise<EcpayFields> {
    const requestFields: Record<string, string> = {
      MerchantID: credentials.merchantId,
      MerchantTradeNo: payment.trade.merchantTradeNo,
      TradeNo: payment.providerRef,
      Action: action,
      TotalAmount: String(amountTwd),
    };
    requestFields.CheckMacValue = createCheckMacValue(requestFields, credentials.hashKey, credentials.hashIv);
    const http = ctx.http({ timeoutMs: ctx.config.creditRefund.timeoutMs, maxAttempts: 1, allowedHosts: ECPAY_CREDIT_REFUND_ALLOWED_HOSTS });
    const response = await http.request({ method: 'POST', url: ECPAY_CREDIT_REFUND_ACTION_URL, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(requestFields).toString() });
    if (!response.ok) throw new Error(`ECPay credit refund action is indeterminate (${response.reason})`);
    const fields = parseActionResponse(response.body);
    if (fields.MerchantID !== credentials.merchantId) {
      throw new Error('ECPay credit refund action is indeterminate (response merchant mismatch)');
    }
    if (fields.TradeNo !== payment.providerRef) {
      throw new Error('ECPay credit refund action is indeterminate (response trade mismatch)');
    }
    if (fields.MerchantTradeNo !== payment.trade.merchantTradeNo) {
      throw new Error('ECPay credit refund action is indeterminate (response merchant trade mismatch)');
    }
    return fields;
  }
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
function providerRefKey(providerRef: string) { return `ecpay:provider-ref:${providerRef}`; }
function refundLedgerKey(providerRef: string) { return `ecpay:refund-ledger:${providerRef}`; }

function sameRefundInput(left: PaymentRefundInputV2, right: PaymentRefundInputV2): boolean {
  return left.providerRef === right.providerRef && left.amount === right.amount && left.currency === right.currency && left.reference === right.reference;
}

function parseCreditQuery(body: { RtnMsg?: unknown; RtnValue?: unknown }): CreditQuery | null {
  if (body.RtnMsg !== '') return null;
  const value = typeof body.RtnValue === 'string' ? parseJson(body.RtnValue) : body.RtnValue;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const amount = integer(record.amount);
  if (amount === null || typeof record.status !== 'string') return null;
  const closeData = Array.isArray(record.close_data)
    ? record.close_data.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const close = entry as Record<string, unknown>;
      const closeAmount = integer(close.amount);
      return typeof close.status === 'string' && closeAmount !== null ? [{ status: close.status, amount: closeAmount }] : [];
    })
    : [];
  return { status: record.status, amount, closeData };
}

function refundActionFor(query: CreditQuery, amountTwd: number): 'R' | 'E' | 'N' | Error {
  if (!Number.isSafeInteger(amountTwd) || amountTwd <= 0 || amountTwd > query.amount) {
    return new Error('ECPay refund amount is unavailable from the current credit query');
  }
  if (query.status === '已授權') return amountTwd === query.amount ? 'N' : new Error('ECPay authorised credit can only be abandoned in full');
  if (query.status === '已關帳') return 'R';
  if (query.status === '操作取消') return 'N';
  if (query.status === '要關帳') {
    const close = [...query.closeData].reverse().find((entry) => entry.amount > 0);
    if (!close || amountTwd > close.amount) return new Error('ECPay pending-close amount is unavailable for refund');
    return amountTwd === close.amount ? 'E' : 'R';
  }
  return new Error(`ECPay credit status requires manual reconciliation: ${query.status}`);
}

function parseActionResponse(body: string): EcpayFields {
  const parsed = body.trim().startsWith('{') ? parseJson(body) : Object.fromEntries(new URLSearchParams(body));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ECPay credit refund action is indeterminate (invalid response)');
  const fields = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string]));
  if (!fields.RtnCode) throw new Error('ECPay credit refund action is indeterminate (missing RtnCode)');
  return fields;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function integer(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

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
