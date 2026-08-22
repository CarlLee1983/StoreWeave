import { z } from 'zod';

export const rewardSource = z.enum(['order-accrual', 'redemption', 'reversal', 'manual', 'expiry']);
export type RewardSource = z.infer<typeof rewardSource>;

export const rewardSettingsDto = z.object({
  /** 累積比例，基點。100 = 1%。畫面上永遠寫成百分比。 */
  accrualBasisPoints: z.number().int().min(0).max(10_000),
  effectiveAfterDays: z.number().int().min(0).max(365),
  expiresAfterDays: z.number().int().positive().max(3_650).nullable(),
  /** 到期前幾天寄通知。 */
  expiryNoticeDays: z.number().int().positive().max(365),
  updatedAt: z.coerce.date(),
});

export const updateRewardSettingsInput = z.object({
  accrualBasisPoints: z.number().int().min(0).max(10_000).optional(),
  effectiveAfterDays: z.number().int().min(0).max(365).optional(),
  expiresAfterDays: z.number().int().positive().max(3_650).nullable().optional(),
  expiryNoticeDays: z.number().int().positive().max(365).optional(),
}).strict();

export const rewardEntryDto = z.object({
  id: z.string().uuid(),
  amountCents: z.number().int(),
  source: z.string(),
  reference: z.string().nullable(),
  effectiveAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullable(),
  reason: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const rewardBalanceDto = z.object({
  availableCents: z.number().int().nonnegative(),
  /** 已入帳但還沒生效。顧客看得到它才不會以為系統壞了。 */
  pendingCents: z.number().int().nonnegative(),
  expiredCents: z.number().int().nonnegative(),
  /** 最近要到期的那一批，讓前台說得出「X 元將於 Y 到期」。 */
  nextExpiry: z.object({
    amountCents: z.number().int().positive(),
    expiresAt: z.coerce.date(),
  }).nullable(),
});

export const getMyRewardsInput = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const getMyRewardsOutput = z.object({
  balance: rewardBalanceDto,
  entries: z.array(rewardEntryDto),
});

export const adjustRewardsInput = z.object({
  customerId: z.string().uuid(),
  /** 正數是給、負數是收回。 */
  amountCents: z.number().int().refine((v) => v !== 0, { message: 'amountCents must not be zero' }),
  reason: z.string().trim().min(1).max(500),
  /** 幾天後到期；省略時沿用店鋪設定。 */
  expiresInDays: z.number().int().positive().max(3_650).nullable().optional(),
}).strict();

export const outstandingRewardsOutput = z.object({
  /** 流通在外的購物金總額：已生效、未過期、還沒被用掉的部分。 */
  availableCents: z.number().int().nonnegative(),
  pendingCents: z.number().int().nonnegative(),
  customerCount: z.number().int().nonnegative(),
});

export const tierDto = z.object({
  name: z.string(),
  thresholdPoints: z.number().int().nonnegative(),
  multiplierBasisPoints: z.number().int().positive(),
});

export const myTierOutput = z.object({
  points: z.number().int().nonnegative(),
  current: tierDto,
  next: z.object({
    tier: tierDto,
    remainingPoints: z.number().int().positive(),
  }).nullable(),
  /** 滾動期間的起點。降級時要解釋得了為什麼，UI 必須說得出這個日期。 */
  windowStartsAt: z.coerce.date(),
  windowMonths: z.number().int().positive(),
});

export const listTiersOutput = z.object({ items: z.array(tierDto) });

export const saveTierInput = z.object({
  name: z.string().trim().min(1).max(60),
  thresholdPoints: z.number().int().min(0).max(10_000_000),
  /** 10_000 = 1 倍。畫面上永遠寫成倍數。 */
  multiplierBasisPoints: z.number().int().min(10_000).max(100_000),
}).strict();

export const removeTierInput = z.object({ name: z.string().trim().min(1).max(60) }).strict();

export const adjustTierPointsInput = z.object({
  customerId: z.string().uuid(),
  points: z.number().int().refine((v) => v !== 0, { message: 'points must not be zero' }),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const recalculateTiersInput = z.object({
  /** 以哪一個時刻的滾動期間重算。省略就是現在——測試靠它驗降級。 */
  at: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
}).strict();

export const recalculateTiersOutput = z.object({
  evaluated: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  upgraded: z.number().int().nonnegative(),
  downgraded: z.number().int().nonnegative(),
});

export const customerLoyaltyInput = z.object({ customerId: z.string().uuid() }).strict();

export const customerLoyaltyOutput = z.object({
  balance: rewardBalanceDto,
  tierName: z.string(),
  tierPoints: z.number().int().nonnegative(),
  entries: z.array(rewardEntryDto),
});

export const notifyExpiringRewardsInput = z.object({
  /** 以哪一個時刻判斷「快到期」。省略就是現在——測試靠它驗邊界。 */
  at: z.coerce.date().optional(),
}).strict();

export const notifyExpiringRewardsOutput = z.object({
  notified: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
