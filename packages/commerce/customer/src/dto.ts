import { z } from 'zod';

export const customerDto = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  displayName: z.string(),
  birthday: z.string().nullable(),
  phone: z.string().nullable(),
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
});

export const registerCustomerOutput = z.object({
  customer: customerDto,
  accountId: z.string().uuid(),
  email: z.string().email(),
});
