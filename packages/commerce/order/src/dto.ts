import { z } from 'zod';

export const orderStatus = z.enum(['pending', 'payment_processing', 'paid', 'cancelled', 'expired']);
export type OrderStatus = z.infer<typeof orderStatus>;

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
  source: z.literal('promotion'),
  sourceId: z.string(),
  name: z.string(),
  /** 折扣為負數。訂單總額 = 小計 + 所有 Adjustment。 */
  amountCents: z.number().int(),
});

export const orderDto = z.object({
  id: z.string().uuid(),
  number: z.string(),
  status: orderStatus,
  currency: z.string().length(3),
  customerEmail: z.string().email(),
  subtotalCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  shippingCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  lines: z.array(orderLineDto),
  adjustments: z.array(orderAdjustmentDto),
  placedAt: z.coerce.date(),
  paidAt: z.coerce.date().nullable(),
  cancelledAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});
export type OrderDto = z.infer<typeof orderDto>;

/** 上限必須與 `quoteInput`（`packages/commerce/promotion/src/dto.ts`）相同。 */
export const placeOrderInput = z.object({
  customerEmail: z.string().email(),
  currency: z.string().length(3).optional(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(999),
  })).min(1).max(50),
  metadata: z.record(z.unknown()).optional(),
});

export const payOrderInput = z.object({
  orderId: z.string().uuid(),
  /** 不指定就用預設的 payment provider。 */
  provider: z.string().optional(),
});

export const markPaidInput = z.object({
  orderId: z.string().uuid(),
  provider: z.string(),
  providerRef: z.string(),
});

export const cancelOrderInput = z.object({
  orderId: z.string().uuid(),
  reason: z.string().max(500).default('customer request'),
});

export const getOrderInput = z.object({
  id: z.string().uuid().optional(),
  number: z.string().optional(),
}).refine((v) => Boolean(v.id || v.number), { message: 'Either id or number is required' });

export const listOrdersInput = z.object({
  status: orderStatus.optional(),
  customerEmail: z.string().email().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listOrdersOutput = z.object({
  items: z.array(orderDto),
  total: z.number().int().nonnegative(),
});

export const salesSummaryInput = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

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
