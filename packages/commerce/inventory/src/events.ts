import { z } from 'zod';
import { defineEvent } from '@storeweave/contracts';

export const inventoryAdjustedV1 = defineEvent({
  name: 'commerce.inventory.adjusted.v1',
  summary: '庫存異動',
  payload: z.object({
    productId: z.string().uuid(),
    delta: z.number().int(),
    onHand: z.number().int().nonnegative(),
    reason: z.string(),
    reference: z.string().nullable(),
  }),
});

export const inventoryEvents = [inventoryAdjustedV1];
