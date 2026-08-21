import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';

export const productCreatedV1 = defineEvent({
  name: 'commerce.product.created.v1',
  summary: '商品建立完成',
  payload: z.object({
    productId: z.string().uuid(),
    sku: z.string(),
    name: z.string(),
    priceCents: z.number().int().nonnegative(),
    currency: z.string().length(3),
    status: z.string(),
  }),
});

export const productUpdatedV1 = defineEvent({
  name: 'commerce.product.updated.v1',
  summary: '商品資料更新',
  payload: z.object({
    productId: z.string().uuid(),
    sku: z.string(),
    changed: z.array(z.string()),
  }),
});

export const catalogEvents = [productCreatedV1, productUpdatedV1];
