import { z } from 'zod';

export const mockPaymentConfig = z.object({
  /** 設為 false 可以模擬全部拒付，用來測試付款失敗路徑。 */
  autoApprove: z.boolean().default(true),
  /** 超過這個金額就拒付；0 代表不限制。 */
  declineAboveCents: z.number().int().nonnegative().default(0),
  /** 模擬處理延遲（毫秒）。 */
  latencyMs: z.number().int().min(0).max(5000).default(0),
});

export type MockPaymentConfig = z.infer<typeof mockPaymentConfig>;
