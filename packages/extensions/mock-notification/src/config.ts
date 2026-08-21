import { z } from 'zod';

export const mockNotificationConfig = z.object({
  /** 設為 false 可以模擬全部寄送失敗，用來測試通知失敗路徑。 */
  deliver: z.boolean().default(true),
});

export type MockNotificationConfig = z.infer<typeof mockNotificationConfig>;
