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

export const orderEvents = [orderPlacedV1, orderPaidV1, orderCancelledV1];
