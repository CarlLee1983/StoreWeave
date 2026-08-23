import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';

const lineSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  lineTotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  netCents: z.number().int().nonnegative(),
});

const adjustmentSchema = z.object({
  source: z.string(),
  sourceId: z.string(),
  name: z.string(),
  amountCents: z.number().int(),
});

/**
 * 訂單成立。v1 與 v2 已於工單 24 下線——它們少了折扣、運費、稅與調整明細，
 * 而 `totalCents` 在兩個版本裡的語意還不一樣（ADR 0017）。
 * `customerId` 是帶預設值的選填欄位，既有欄位語意不動（ADR 0006）。
 */
export const orderPlacedV3 = defineEvent({
  name: 'commerce.order.placed.v3',
  summary: '訂單成立並預留庫存，含金額與調整明細',
  payload: z.object({
    orderId: z.string().uuid(), orderNumber: z.string(), customerEmail: z.string().email(),
    // default(null)：舊的 outbox 列沒有這個鍵，nullable 擋不住「缺鍵」，只有預設值才是真的相加式。
    customerId: z.string().uuid().nullable().default(null),
    currency: z.string().length(3), placedAt: z.coerce.date(), expiresAt: z.coerce.date(),
    subtotalCents: z.number().int().nonnegative(), discountCents: z.number().int().nonnegative(),
    shippingCents: z.number().int().nonnegative(), taxCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(), adjustments: z.array(adjustmentSchema),
    lines: z.array(lineSchema),
  }),
});

/** 訂單付款成功。v1 已於工單 24 下線，理由與 placed 那一組相同。 */
export const orderPaidV2 = defineEvent({
  name: 'commerce.order.paid.v2',
  summary: '訂單付款成功，含金額與調整明細',
  payload: z.object({
    orderId: z.string().uuid(), orderNumber: z.string(), customerEmail: z.string().email(),
    // default(null)：舊的 outbox 列沒有這個鍵，nullable 擋不住「缺鍵」，只有預設值才是真的相加式。
    customerId: z.string().uuid().nullable().default(null),
    currency: z.string().length(3), paidAt: z.coerce.date(), paymentProvider: z.string(), paymentRef: z.string(),
    subtotalCents: z.number().int().nonnegative(), discountCents: z.number().int().nonnegative(),
    shippingCents: z.number().int().nonnegative(), taxCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(), adjustments: z.array(adjustmentSchema),
    lines: z.array(lineSchema),
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

export const orderEvents = [orderPlacedV3, orderPaidV2, orderCancelledV1];
