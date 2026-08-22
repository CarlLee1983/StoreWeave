import { z } from 'zod';

export const addressDto = z.object({
  recipient: z.string().min(1).max(120),
  phone: z.string().min(1).max(40),
  postcode: z.string().min(1).max(20),
  city: z.string().min(1).max(80),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable().default(null),
});

/**
 * 輸入用的嚴格版本。`addressDto` 本身是顧客資料讀回來時走的那一支，收緊它會讓
 * 舊資料裡多存的鍵變成「這位顧客的資料從此讀不回來」——那比多存一個鍵嚴重得多。
 */
export const addressInput = addressDto.strict();

/** 生日只存日期，不存時刻——它是禮券的依據，不是時間戳。 */
const birthday = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'birthday must be YYYY-MM-DD');

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
