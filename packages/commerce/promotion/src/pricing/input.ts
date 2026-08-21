import { z } from 'zod';

/**
 * 金額一律是整數分。分攤的無條件捨去與餘數規則全部建立在這個假設上，
 * 一旦有小數，「行折扣合計等於訂單折扣」就不再成立。活動與商品行都來自
 * 資料庫，因此在引擎入口驗一次，而不是相信呼叫端的型別宣告。
 */
const pricingLineSchema = z.object({
  lineId: z.string().min(1),
  productId: z.string().min(1),
  unitPriceCents: z.number().int().nonnegative(),
  quantity: z.number().int().nonnegative(),
  categories: z.array(z.string()).optional(),
});

const moneyInputSchema = z.object({
  lines: z.array(pricingLineSchema),
  shippingCents: z.number().int().nonnegative().optional(),
  taxCents: z.number().int().nonnegative().optional(),
});

export function assertValidPricingInput(input: {
  lines: readonly unknown[];
  shippingCents?: number;
  taxCents?: number;
}): void {
  const parsed = moneyInputSchema.safeParse(input);
  if (parsed.success) return;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid pricing input — ${detail}`);
}
