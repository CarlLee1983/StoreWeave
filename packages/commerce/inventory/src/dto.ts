import { z } from 'zod';

export const stockDto = z.object({
  productId: z.string().uuid(),
  onHand: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  available: z.number().int(),
  updatedAt: z.coerce.date(),
});
export type StockDto = z.infer<typeof stockDto>;

export const adjustStockInput = z.object({
  productId: z.string().uuid(),
  /** 正數進貨、負數扣減。 */
  delta: z.number().int().refine((v) => v !== 0, { message: 'delta must not be zero' }),
  reason: z.enum(['restock', 'correction', 'damage', 'return', 'manual']).default('manual'),
  reference: z.string().max(200).optional(),
});

export const getStockInput = z.object({ productId: z.string().uuid() });

export const listStockInput = z.object({
  belowQuantity: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listStockOutput = z.object({
  items: z.array(stockDto),
  total: z.number().int().nonnegative(),
});
