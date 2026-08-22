import { z } from 'zod';

/** 訪客 token 由前台的 cookie 帶進來；會員身分優先，兩者同時出現時以會員為準。 */
const owner = { guestToken: z.string().min(16).max(200).optional() };
const quantity = z.number().int().min(1).max(999);

export const cartItemDto = z.object({
  productId: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  unitPriceCents: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  lineTotalCents: z.number().int().nonnegative(),
  /** 攤到這一行的折扣與折後金額，來源與結帳同一個定價引擎。 */
  discountCents: z.number().int().nonnegative(),
  netCents: z.number().int().nonnegative(),
  /** 目前可售量，null 代表沒有庫存紀錄。購物車不預留，這只是顯示用。 */
  available: z.number().int().nullable(),
});

/** 與 `quoteOutput` 的調整明細同形：兩個入口說的是同一件事。 */
export const cartAdjustmentDto = z.object({
  source: z.literal('promotion'),
  sourceId: z.string(),
  name: z.string(),
  amountCents: z.number().int(),
});

export const cartDto = z.object({
  id: z.string().uuid(),
  currency: z.string().length(3),
  items: z.array(cartItemDto),
  subtotalCents: z.number().int().nonnegative(),
  /** 以下三項是**當下**重算的預估金額：購物車不凍結價格，也不鎖定任何額度。 */
  discountCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  adjustments: z.array(cartAdjustmentDto),
});
export type CartDto = z.infer<typeof cartDto>;

export const getCartInput = z.object({ ...owner });
export const addToCartInput = z.object({ ...owner, productId: z.string().uuid(), quantity: quantity.default(1) });
export const setCartItemQuantityInput = z.object({
  ...owner,
  productId: z.string().uuid(),
  /** 0 等於移除：前台的數量選單本來就會走到 0，讓它自然表達「不要了」。 */
  quantity: z.number().int().min(0).max(999),
});
export const removeCartItemInput = z.object({ ...owner, productId: z.string().uuid() });
export const clearCartInput = z.object({ ...owner });
