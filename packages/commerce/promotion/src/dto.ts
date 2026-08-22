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

/**
 * 輸入用的嚴格版本。`promotionRule` 本身**不能**收緊——它同時是活動從 jsonb 讀回來時
 * 走的那一支，而舊資料裡可能有當初沒被擋下來的多餘鍵；一起收緊會把「建立時被忽略的欄位」
 * 變成「這檔活動從此讀不回來」，用一個看得見的錯誤換掉另一個更嚴重的。
 */
export const promotionRuleInput = z.discriminatedUnion('type', [
  promotionRule.options[0].strict(),
  promotionRule.options[1].strict(),
  promotionRule.options[2].strict(),
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
  /** 需要券才套用；這種活動不會人人適用。 */
  requiresCoupon: z.boolean(),
  autoIssue: z.enum(['signup', 'birthday']).nullable(),
  autoIssueValidDays: z.number().int().positive().nullable(),
  /** 只有這些等級適用；空陣列是人人適用。 */
  tierNames: z.array(z.string()),
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
    rule: promotionRuleInput,
    /** 數字小的先套用。 */
    priority: z.number().int().min(-1000).max(1000).default(0),
    stackable: z.boolean().default(true),
    requiresCoupon: z.boolean().default(false),
    /** 自動發券的觸發。設了它就必須 requiresCoupon——發出去的券要有東西可指。 */
    autoIssue: z.enum(['signup', 'birthday']).optional(),
    autoIssueValidDays: z.number().int().positive().max(3_650).optional(),
    tierNames: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    status: promotionStatus.default('active'),
    ...period,
  })
  // strict：`{"requiresCoupons": true}` 這種拼字錯誤會安靜地建出一檔全站打折的活動並回 200。
  .strict()
  .refine(endsAfterStarts, endsAfterStartsMessage)
  // 自動發出去的是券，券只能指向需要券的活動——否則所有人不用券就有折扣。
  .refine((v) => !v.autoIssue || v.requiresCoupon, {
    message: 'autoIssue requires requiresCoupon',
    path: ['requiresCoupon'],
  });

/** strict：`{"status":"disabled"}` 這種送錯欄位的請求要回 400，不能回 200 又什麼都沒改。 */
export const updatePromotionInput = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120).optional(),
    rule: promotionRuleInput.optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    stackable: z.boolean().optional(),
    requiresCoupon: z.boolean().optional(),
    autoIssue: z.enum(['signup', 'birthday']).nullable().optional(),
    autoIssueValidDays: z.number().int().positive().max(3_650).nullable().optional(),
    tierNames: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    ...period,
  })
  .strict()
  .refine(endsAfterStarts, endsAfterStartsMessage);

export const setPromotionStatusInput = z.object({
  id: z.string().uuid(),
  status: promotionStatus,
}).strict();

export const getPromotionInput = z.object({ id: z.string().uuid() }).strict();

export const listPromotionsInput = z.object({
  status: promotionStatus.optional(),
  /** 只列出在這個時刻生效中的活動。 */
  activeAt: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const listPromotionsOutput = z.object({
  items: z.array(promotionDto),
  total: z.number().int().nonnegative(),
});

/** 上限必須與 `placeOrderInput`（`packages/commerce/order/src/dto.ts`）相同，否則會出現「試算得到、下單被擋」。 */
export const quoteInput = z.object({
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(999),
  }).strict()).min(1).max(50),
}).strict();

const quoteAdjustment = z.object({
  source: z.enum(['promotion', 'reward']),
  sourceId: z.string(),
  name: z.string(),
  amountCents: z.number().int(),
});

/** 差一點就達成的門檻活動。前台靠它說「還差多少」。 */
export const nextThresholdDto = z.object({
  promotionId: z.string(),
  name: z.string(),
  thresholdCents: money,
  remainingCents: z.number().int().positive(),
}).nullable();

export const quoteOutput = z.object({
  currency: z.string().length(3),
  subtotalCents: money,
  discountCents: money,
  shippingCents: money,
  taxCents: money,
  totalCents: money,
  adjustments: z.array(quoteAdjustment),
  nextThreshold: nextThresholdDto,
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
