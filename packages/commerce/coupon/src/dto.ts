import { z } from 'zod';

export const couponStatus = z.enum(['issued', 'used', 'void']);
export type CouponStatus = z.infer<typeof couponStatus>;

/**
 * 券碼的字集刻意窄：顧客要用手打，客服要用電話念。
 * 比對前一律轉大寫，`summer20` 與 `SUMMER20` 是同一張券。
 */
export const couponCode = z.string().trim().min(4).max(40).regex(/^[A-Za-z0-9_-]+$/, {
  message: 'A coupon code may only contain letters, digits, hyphens and underscores',
});

export const couponDto = z.object({
  id: z.string().uuid(),
  code: z.string(),
  promotionId: z.string().uuid(),
  status: couponStatus,
  /** null 代表共用碼：誰都能用。 */
  customerId: z.string().uuid().nullable(),
  partnerCode: z.string().nullable(),
  startsAt: z.coerce.date().nullable(),
  endsAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CouponDto = z.infer<typeof couponDto>;

const period = {
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
};

const endsAfterStarts = (v: { startsAt?: Date; endsAt?: Date }) =>
  !v.startsAt || !v.endsAt || v.endsAt.getTime() > v.startsAt.getTime();
const endsAfterStartsMessage = { message: 'endsAt must be later than startsAt', path: ['endsAt'] };

export const createCouponInput = z
  .object({
    code: couponCode,
    promotionId: z.string().uuid(),
    /** 指定擁有者就是實發券；省略是共用碼。 */
    customerId: z.string().uuid().optional(),
    partnerCode: z.string().trim().min(1).max(60).optional(),
    ...period,
  })
  .strict()
  .refine(endsAfterStarts, endsAfterStartsMessage);

export const setCouponStatusInput = z.object({
  id: z.string().uuid(),
  status: couponStatus,
}).strict();

export const getCouponInput = z.object({ code: couponCode }).strict();

export const listCouponsInput = z.object({
  status: couponStatus.optional(),
  promotionId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const listCouponsOutput = z.object({
  items: z.array(couponDto),
  total: z.number().int().nonnegative(),
});
