import { z } from 'zod';

const money = z.number().int().nonnegative();
/** 1 = 折 0.01%，10_000 = 全免。用基點才存得下「打 99 折」這種折數。 */
const basisPoints = z.number().int().min(1).max(10_000);
const maxDiscount = money.nullable().optional();

/**
 * 規則參數依型別驗證。discriminated union 讓錯誤訊息指得出是哪一個型別的哪一個欄位，
 * 而且是這批規則型別在執行期的唯一真相——活動從資料庫的 jsonb 讀回來時也走它。
 */
export const promotionRule = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('threshold_fixed_amount'),
    thresholdCents: money,
    discountCents: money.refine((v) => v > 0, { message: 'discountCents must be greater than zero' }),
  }),
  z.object({
    type: z.literal('threshold_percentage'),
    thresholdCents: money,
    percentOffBasisPoints: basisPoints,
    maxDiscountCents: maxDiscount,
  }),
  z.object({
    type: z.literal('order_percentage'),
    percentOffBasisPoints: basisPoints,
    maxDiscountCents: maxDiscount,
  }),
]);

export const promotionStatus = z.enum(['active', 'disabled']);
export type PromotionStatus = z.infer<typeof promotionStatus>;

export const promotionDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: promotionStatus,
  rule: promotionRule,
  priority: z.number().int(),
  stackable: z.boolean(),
  startsAt: z.coerce.date().nullable(),
  endsAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PromotionDto = z.infer<typeof promotionDto>;

const period = {
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
};

/** 結束時間早於或等於開始時間的活動永遠不會生效，建立時就擋掉而不是讓經營者納悶。 */
const endsAfterStarts = (v: { startsAt?: Date; endsAt?: Date }) =>
  !v.startsAt || !v.endsAt || v.endsAt.getTime() > v.startsAt.getTime();
const endsAfterStartsMessage = { message: 'endsAt must be later than startsAt', path: ['endsAt'] };

export const createPromotionInput = z
  .object({
    name: z.string().min(1).max(120),
    rule: promotionRule,
    /** 數字小的先套用。 */
    priority: z.number().int().min(-1000).max(1000).default(0),
    stackable: z.boolean().default(true),
    status: promotionStatus.default('active'),
    ...period,
  })
  .refine(endsAfterStarts, endsAfterStartsMessage);

export const updatePromotionInput = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120).optional(),
    rule: promotionRule.optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    stackable: z.boolean().optional(),
    ...period,
  })
  .refine(endsAfterStarts, endsAfterStartsMessage);

export const setPromotionStatusInput = z.object({
  id: z.string().uuid(),
  status: promotionStatus,
});

export const getPromotionInput = z.object({ id: z.string().uuid() });

export const listPromotionsInput = z.object({
  status: promotionStatus.optional(),
  /** 只列出在這個時刻生效中的活動。 */
  activeAt: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listPromotionsOutput = z.object({
  items: z.array(promotionDto),
  total: z.number().int().nonnegative(),
});

export const quoteInput = z.object({
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(999),
  })).min(1).max(50),
});

const quoteAdjustment = z.object({
  source: z.literal('promotion'),
  sourceId: z.string(),
  name: z.string(),
  amountCents: z.number().int(),
});

export const quoteOutput = z.object({
  currency: z.string().length(3),
  subtotalCents: money,
  discountCents: money,
  shippingCents: money,
  taxCents: money,
  totalCents: money,
  adjustments: z.array(quoteAdjustment),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    sku: z.string(),
    name: z.string(),
    unitPriceCents: money,
    quantity: z.number().int().positive(),
    lineTotalCents: money,
    discountCents: money,
    netCents: money,
  })),
});
