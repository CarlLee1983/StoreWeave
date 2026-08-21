import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';

const lineSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  lineTotalCents: z.number().int().nonnegative(),
});

const lineWithDiscountSchema = lineSchema.extend({
  discountCents: z.number().int().nonnegative(),
  netCents: z.number().int().nonnegative(),
});

const adjustmentSchema = z.object({
  source: z.string(),
  sourceId: z.string(),
  name: z.string(),
  amountCents: z.number().int(),
});

export const orderPlacedV1 = defineEvent({
  name: 'commerce.order.placed.v1',
  summary: '訂單成立',
  payload: z.object({
    orderId: z.string().uuid(),
    orderNumber: z.string(),
    customerEmail: z.string().email(),
    currency: z.string().length(3),
    totalCents: z.number().int().nonnegative(),
    placedAt: z.coerce.date(),
    lines: z.array(lineSchema),
  }),
});

/** v1 曾被部署描述為「已扣庫存」；v2 明確承諾的是預留，保留 v1 供既有訂閱者遷移。 */
export const orderPlacedV2 = defineEvent({
  name: 'commerce.order.placed.v2',
  summary: '訂單成立並預留庫存',
  payload: z.object({
    orderId: z.string().uuid(), orderNumber: z.string(), customerEmail: z.string().email(),
    currency: z.string().length(3), totalCents: z.number().int().nonnegative(), placedAt: z.coerce.date(),
    expiresAt: z.coerce.date(), lines: z.array(lineSchema),
  }),
});

/** v3 補上折扣、運費、稅與調整明細；金額欄位在定價引擎接上（工單 15）前恆為 0。 */
export const orderPlacedV3 = defineEvent({
  name: 'commerce.order.placed.v3',
  summary: '訂單成立並預留庫存，含金額與調整明細',
  payload: z.object({
    orderId: z.string().uuid(), orderNumber: z.string(), customerEmail: z.string().email(),
    currency: z.string().length(3), placedAt: z.coerce.date(), expiresAt: z.coerce.date(),
    subtotalCents: z.number().int().nonnegative(), discountCents: z.number().int().nonnegative(),
    shippingCents: z.number().int().nonnegative(), taxCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(), adjustments: z.array(adjustmentSchema),
    lines: z.array(lineWithDiscountSchema),
  }),
});

export const orderPaidV1 = defineEvent({
  name: 'commerce.order.paid.v1',
  summary: '訂單付款成功',
  payload: z.object({
    orderId: z.string().uuid(),
    orderNumber: z.string(),
    customerEmail: z.string().email(),
    currency: z.string().length(3),
    totalCents: z.number().int().nonnegative(),
    paidAt: z.coerce.date(),
    paymentProvider: z.string(),
    paymentRef: z.string(),
    lines: z.array(lineSchema),
  }),
});

/** v2 補上折扣、運費、稅與調整明細；金額欄位在定價引擎接上（工單 15）前恆為 0。 */
export const orderPaidV2 = defineEvent({
  name: 'commerce.order.paid.v2',
  summary: '訂單付款成功，含金額與調整明細',
  payload: z.object({
    orderId: z.string().uuid(), orderNumber: z.string(), customerEmail: z.string().email(),
    currency: z.string().length(3), paidAt: z.coerce.date(), paymentProvider: z.string(), paymentRef: z.string(),
    subtotalCents: z.number().int().nonnegative(), discountCents: z.number().int().nonnegative(),
    shippingCents: z.number().int().nonnegative(), taxCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(), adjustments: z.array(adjustmentSchema),
    lines: z.array(lineWithDiscountSchema),
  }),
});

export const orderCancelledV1 = defineEvent({
  name: 'commerce.order.cancelled.v1',
  summary: '訂單取消',
  payload: z.object({
    orderId: z.string().uuid(),
    orderNumber: z.string(),
    reason: z.string(),
    cancelledAt: z.coerce.date(),
    restockedLines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int() })),
  }),
});

export const orderEvents = [orderPlacedV1, orderPlacedV2, orderPlacedV3, orderPaidV1, orderPaidV2, orderCancelledV1];
