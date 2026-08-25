import { z } from 'zod';

export const addressDto = z.object({
  /** 首波配送範圍是台灣；輸出永遠明示國別，避免把舊資料誤當成可寄往任意地區。 */
  countryCode: z.literal('TW').default('TW'),
  recipient: z.string().min(1).max(120),
  phone: z.string().min(1).max(40),
  postcode: z.string().min(1).max(20),
  city: z.string().min(1).max(80),
  /** 舊的個人檔案沒有這個欄位；結帳的台灣宅配目的地會再要求它存在。 */
  district: z.string().min(1).max(80).nullable().default(null),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable().default(null),
});

/**
 * 輸入用的嚴格版本。`addressDto` 本身是顧客資料讀回來時走的那一支，收緊它會讓
 * 舊資料裡多存的鍵變成「這位顧客的資料從此讀不回來」——那比多存一個鍵嚴重得多。
 */
export const addressInput = addressDto.strict();

/** 生日只存日期，不存時刻——它是禮券的依據，不是時間戳。 */
/**
 * 形狀對不代表日期存在：`1990-02-31` 過得了 regex。生日決定發券資格，
 * 所以這裡要的是一個真的日曆日，而且不在未來、不早於 1900。
 */
const birthday = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'birthday must be YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, 'birthday must be a real calendar date')
  .refine((value) => value >= '1900-01-01', 'birthday must not be before 1900');

export const customerDto = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  displayName: z.string(),
  birthday: z.string().nullable(),
  phone: z.string().nullable(),
  address: addressDto.nullable(),
  status: z.enum(['active', 'disabled']),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CustomerDto = z.infer<typeof customerDto>;

/**
 * 8 個字元是前台的下限，後台操作者仍是 12：一個是購物站的轉換率，一個是能改設定、
 * 看得到所有訂單的帳號。長度優先、不強制大小寫與符號，複雜度規則只會逼出可預測的變形。
 */
export const registerCustomerInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(120).optional(),
}).strict();

export const registerCustomerOutput = z.object({
  customer: customerDto,
  accountId: z.string().uuid(),
  email: z.string().email(),
});

export const updateMyProfileInput = z.object({
  displayName: z.string().min(1).max(120).optional(),
  phone: z.string().min(1).max(40).optional(),
  birthday: birthday.optional(),
  address: addressInput.optional(),
}).strict();

export const setCustomerBirthdayInput = z.object({
  customerId: z.string().uuid(),
  birthday,
  /** 生日決定發券資格，改它要說得出為什麼；沒有理由的更正事後查不到帳。 */
  reason: z.string().trim().min(1).max(500),
}).strict();

/** 後台看到的會員：顧客資料 + 帳號 email。永遠不含密碼雜湊。 */
export const adminCustomerDto = customerDto.extend({
  email: z.string().email(),
});

export const listCustomersInput = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const listCustomersOutput = z.object({
  items: z.array(adminCustomerDto),
  total: z.number().int().nonnegative(),
});

export const customerOrderDto = z.object({
  id: z.string().uuid(),
  number: z.string(),
  status: z.string(),
  currency: z.string().length(3),
  totalCents: z.number().int(),
  placedAt: z.coerce.date(),
});

export const adminCustomerDetailDto = adminCustomerDto.extend({
  orders: z.array(customerOrderDto),
});

export const setCustomerStatusInput = z.object({
  customerId: z.string().uuid(),
  status: z.enum(['active', 'disabled']),
}).strict();
