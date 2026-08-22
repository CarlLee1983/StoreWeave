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
  maxRedemptions: z.number().int().positive().nullable(),
  redeemedCount: z.number().int().nonnegative(),
  perCustomerLimit: z.number().int().positive().nullable(),
  source: z.string(),
  batchId: z.string().uuid().nullable(),
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
    /** 總使用次數上限。省略是不限量。 */
    maxRedemptions: z.number().int().positive().max(1_000_000).optional(),
    /**
     * 每個會員最多用幾次。預設 1——一組碼被同一個人洗完是最常見的損失，
     * 讓它需要明確地被關掉，而不是需要明確地被打開。
     */
    perCustomerLimit: z.number().int().positive().max(1_000).nullable().default(1),
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

/** 發放來源。三個觸發共用同一支內部發放函式，來源只是為了事後追得回來。 */
export const couponSource = z.enum(['manual', 'signup', 'birthday']);
export type CouponSource = z.infer<typeof couponSource>;

export const issueCouponsInput = z.object({
  promotionId: z.string().uuid(),
  /** 指名的會員。省略時代表發給全體有效會員。 */
  customerIds: z.array(z.string().uuid()).min(1).max(5_000).optional(),
  /** 券碼的前綴，方便經營者在後台一眼認出是哪一批。 */
  codePrefix: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9]+$/).optional(),
  /** 幾天後到期。省略是不設到期日。 */
  expiresInDays: z.number().int().min(1).max(3_650).optional(),
  perCustomerLimit: z.number().int().positive().max(1_000).nullable().default(1),
}).strict();

export const issueCouponsOutput = z.object({
  batchId: z.string().uuid(),
  /** 這一批實際發出幾張。已經領過（去重鍵撞上）的不算。 */
  issued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
