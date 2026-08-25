import { z } from 'zod';
import { shippingDestinationInput } from '@storeweave/shipping';

export const orderStatus = z.enum(['pending', 'payment_processing', 'awaiting_payment', 'paid', 'cancelled', 'expired']);
export type OrderStatus = z.infer<typeof orderStatus>;

export const paymentAttemptStatus = z.enum(['created', 'submitted', 'awaiting_payment', 'succeeded', 'failed', 'expired']);
export type PaymentAttemptStatus = z.infer<typeof paymentAttemptStatus>;

export const paymentActionDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('redirect'), url: z.string().url() }),
  z.object({ type: z.literal('form_post'), url: z.string().url(), fields: z.record(z.string()) }),
]);

export const paymentInstructionDto = z.object({ label: z.string(), value: z.string() });

/** Operational payment evidence used by staff, callbacks, and reconciliation. */
export const paymentAttemptDto = z.object({
  id: z.string().uuid(),
  attemptRef: z.string(),
  provider: z.string(),
  method: z.string(),
  providerRef: z.string().nullable(),
  amountCents: z.number().int().nonnegative(),
  status: paymentAttemptStatus,
  action: paymentActionDto.nullable(),
  instructions: z.array(paymentInstructionDto).nullable(),
  expiresAt: z.coerce.date().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PaymentAttemptDto = z.infer<typeof paymentAttemptDto>;

/**
 * Customer-facing payment progress. Provider references, internal attempt
 * references, and raw gateway diagnostics remain operational evidence; a
 * browser never needs them to resume or retry payment.
 */
export const customerPaymentAttemptDto = z.object({
  provider: z.string(),
  method: z.string(),
  amountCents: z.number().int().nonnegative(),
  status: paymentAttemptStatus,
  action: paymentActionDto.nullable(),
  instructions: z.array(paymentInstructionDto).nullable(),
  expiresAt: z.coerce.date().nullable(),
  /** A stable, customer-safe explanation; never the gateway's raw message. */
  failureReason: z.enum(['payment_not_completed']).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CustomerPaymentAttemptDto = z.infer<typeof customerPaymentAttemptDto>;

/**
 * The invoice module receives this immutable checkout snapshot after payment.
 * It contains no tax ID because the merchant chose B2C-only issuance.
 */
export const invoicePreferenceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ecpay') }).strict(),
  z.object({ kind: z.literal('mobile'), number: z.string().regex(/^\/[0-9A-Z+\-.]{7}$/, 'must be a valid mobile barcode') }).strict(),
  z.object({ kind: z.literal('natural_person'), number: z.string().regex(/^[A-Z]{2}[0-9]{14}$/, 'must be a natural-person certificate number') }).strict(),
  z.object({ kind: z.literal('donation'), loveCode: z.string().regex(/^\d{3,7}$/, 'must be a 3–7 digit love code') }).strict(),
]);
export type InvoicePreferenceInput = z.infer<typeof invoicePreferenceInput>;

export const orderLineDto = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  unitPriceCents: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  lineTotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
});

export const orderAdjustmentDto = z.object({
  /** 折扣來自活動或購物金折抵。 */
  source: z.enum(['promotion', 'reward']),
  sourceId: z.string(),
  name: z.string(),
  /** 折扣為負數。訂單總額 = 小計 + 所有 Adjustment。 */
  amountCents: z.number().int(),
});

/** Immutable checkout-time delivery choice. The shipping method's current fee is not read here. */
export const orderDeliveryDto = z.object({
  shippingMethodId: z.string().uuid(),
  shippingMethodCode: z.string(),
  shippingMethodName: z.string(),
  provider: z.string(),
  type: z.string(),
  destinationKind: z.enum(['taiwan_home', 'pickup_store']),
  destination: shippingDestinationInput,
  createdAt: z.coerce.date(),
});
export type OrderDeliveryDto = z.infer<typeof orderDeliveryDto>;

export const orderDto = z.object({
  id: z.string().uuid(),
  number: z.string(),
  status: orderStatus,
  currency: z.string().length(3),
  customerEmail: z.string().email(),
  customerId: z.string().uuid().nullable(),
  subtotalCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  shippingCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  lines: z.array(orderLineDto),
  adjustments: z.array(orderAdjustmentDto),
  paymentAttempts: z.array(paymentAttemptDto),
  delivery: orderDeliveryDto.nullable(),
  placedAt: z.coerce.date(),
  paidAt: z.coerce.date().nullable(),
  cancelledAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});
export type OrderDto = z.infer<typeof orderDto>;

/** Identical order data with payment evidence reduced to customer-safe fields. */
export const customerOrderDto = orderDto.extend({
  paymentAttempts: z.array(customerPaymentAttemptDto),
});
export type CustomerOrderDto = z.infer<typeof customerOrderDto>;

/**
 * Commands and scoped reads may return an operational Order to staff/system,
 * or the customer-safe payment projection to the order owner.
 */
export const orderOutputDto = z.union([orderDto, customerOrderDto]);
export type OrderOutputDto = z.infer<typeof orderOutputDto>;

/**
 * 上限必須與 `quoteInput`（`packages/commerce/promotion/src/dto.ts`）相同。
 * strict：`customerEmail` 已於工單 21 移除，舊客戶端繼續送要收到錯誤而不是被靜默丟棄——
 * 那個欄位曾經決定訂單歸屬，安靜忽略它是最糟的失敗方式。
 */
export const placeOrderInput = z.object({
  currency: z.string().length(3).optional(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(999),
  }).strict()).min(1).max(50),
  metadata: z.record(z.unknown()).optional(),
}).strict();

export const payOrderInput = z.object({
  orderId: z.string().uuid(),
  /** 不指定就用預設的 payment provider。 */
  provider: z.string().optional(),
  /** 若 provider 有多種付款方式，結帳在送出去以前必須先選定其中一種。 */
  method: z.string().min(1).max(64).optional(),
}).strict();

export const markPaidInput = z.object({
  orderId: z.string().uuid(),
  provider: z.string(),
  providerRef: z.string(),
  attemptRef: z.string().optional(),
}).strict();

/**
 * Provider 的結果只描述付款嘗試，不直接改寫 Order。Order module 在同一個
 * transaction 裡驗證該 attempt 後才推導訂單狀態，讓 worker 與外部回呼走同一路徑。
 *
 * 最外層維持 object（不是 discriminated union），讓通用 HTTP bridge 能從契約
 * 取得完整欄位白名單；status 對應的必填條件由 refine 守住。
 */
export type RecordPaymentResultInput =
  | { attemptRef: string; provider: string; status: 'confirmed'; providerRef: string }
  | { attemptRef: string; provider: string; status: 'redirect'; providerRef: string; action: z.infer<typeof paymentActionDto> }
  | { attemptRef: string; provider: string; status: 'awaiting_payment'; providerRef: string; instructions: z.infer<typeof paymentInstructionDto>[]; expiresAt: Date }
  | { attemptRef: string; provider: string; status: 'failed'; providerRef?: string; message?: string };

const paymentResultInputShape = z.object({
  attemptRef: z.string().min(1).max(200),
  provider: z.string().min(1).max(100),
  status: z.enum(['confirmed', 'redirect', 'awaiting_payment', 'failed']),
  providerRef: z.string().min(1).max(200).optional(),
  action: paymentActionDto.optional(),
  instructions: z.array(paymentInstructionDto).min(1).optional(),
  expiresAt: z.coerce.date().optional(),
  message: z.string().min(1).max(1000).optional(),
}).strict();

export const recordPaymentResultInput: z.ZodType<RecordPaymentResultInput> = paymentResultInputShape
  .superRefine((value, ctx) => {
    const require = (field: 'providerRef' | 'action' | 'instructions' | 'expiresAt') => {
      if (value[field] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required when status is ${value.status}` });
      }
    };
    const forbid = (field: 'action' | 'instructions' | 'expiresAt' | 'message') => {
      if (value[field] !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is not valid when status is ${value.status}` });
      }
    };

    switch (value.status) {
      case 'confirmed':
        require('providerRef');
        forbid('action'); forbid('instructions'); forbid('expiresAt'); forbid('message');
        break;
      case 'redirect':
        require('providerRef'); require('action');
        forbid('instructions'); forbid('expiresAt'); forbid('message');
        break;
      case 'awaiting_payment':
        require('providerRef'); require('instructions'); require('expiresAt');
        forbid('action'); forbid('message');
        break;
      case 'failed':
        forbid('action'); forbid('instructions'); forbid('expiresAt');
        break;
    }
  }) as z.ZodType<RecordPaymentResultInput>;

export const cancelOrderInput = z.object({
  orderId: z.string().uuid(),
  reason: z.string().max(500).default('customer request'),
}).strict();

export const getOrderInput = z.object({
  id: z.string().uuid().optional(),
  number: z.string().optional(),
}).strict().refine((v) => Boolean(v.id || v.number), { message: 'Either id or number is required' });

export const listOrdersInput = z.object({
  status: orderStatus.optional(),
  customerEmail: z.string().email().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const listOrdersOutput = z.object({
  items: z.array(orderDto),
  total: z.number().int().nonnegative(),
});

export const listOrdersOutputForActor = z.union([
  listOrdersOutput,
  z.object({
    items: z.array(customerOrderDto),
    total: z.number().int().nonnegative(),
  }),
]);

export const salesSummaryInput = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).strict();

export const salesSummaryOutput = z.object({
  from: z.coerce.date().nullable(),
  to: z.coerce.date().nullable(),
  currency: z.string(),
  paidOrderCount: z.number().int().nonnegative(),
  pendingOrderCount: z.number().int().nonnegative(),
  cancelledOrderCount: z.number().int().nonnegative(),
  grossRevenueCents: z.number().int().nonnegative(),
  averageOrderValueCents: z.number().int().nonnegative(),
  topProducts: z.array(z.object({
    productId: z.string().uuid(),
    sku: z.string(),
    name: z.string(),
    quantity: z.number().int(),
    revenueCents: z.number().int(),
  })),
});

/**
 * 結帳的內容全部來自購物車，呼叫端不帶任何商品行——
 * 「顧客看到的車」與「結出來的單」因此不可能是兩份不同的東西。
 */
export const checkoutCartInput = z.object({
  /**
   * 購物車識別碼是這次結帳的身分：重複送出同一台車，得到同一張訂單。
   *
   * HTTP 層的冪等鍵由伺服器從它導出，客戶端送的 `Idempotency-Key` 會被忽略
   * （ADR 0022）——重送表單的瀏覽器不會、也沒辦法帶同一把鍵。
   */
  cartId: z.string().uuid(),
  /** The merchant-owned method selected for this checkout. */
  shippingMethodId: z.string().uuid(),
  /** Home deliveries use a complete address; pickup uses a server-issued selection capability. */
  destination: shippingDestinationInput.optional(),
  pickupSelectionToken: z.string().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  pickupRecipient: z.string().min(1).max(120).optional(),
  pickupPhone: z.string().min(1).max(40).optional(),
  /** Defaults to ECPay's email/phone carrier when the customer makes no choice. */
  invoicePreference: invoicePreferenceInput.optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if (value.pickupSelectionToken) {
    if (value.destination) context.addIssue({ code: z.ZodIssueCode.custom, path: ['destination'], message: 'Pickup checkout must use the verified selection token only' });
    if (!value.pickupRecipient) context.addIssue({ code: z.ZodIssueCode.custom, path: ['pickupRecipient'], message: 'Pickup recipient is required' });
    if (!value.pickupPhone) context.addIssue({ code: z.ZodIssueCode.custom, path: ['pickupPhone'], message: 'Pickup phone is required' });
  } else if (!value.destination) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['destination'], message: 'A delivery destination is required' });
  } else if (value.destination.kind === 'pickup_store') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['pickupSelectionToken'], message: 'Pickup checkout requires a verified selection token' });
  }
});
