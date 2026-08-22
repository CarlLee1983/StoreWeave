import { z } from 'zod';

export const mockNotificationConfig = z.object({
  /** 設為 false 可以模擬全部寄送失敗，用來測試通知失敗路徑。 */
  deliver: z.boolean().default(true),
  /**
   * 是否連同可能夾帶一次性憑證的變數（重設連結、驗證碼）一起留存。
   * 預設關閉：開發用的儲存不該變成一份可用的重設連結清單。
   * 整合測試需要斷言信件內容時才打開。
   */
  retainSensitiveVariables: z.boolean().default(false),
});

export type MockNotificationConfig = z.infer<typeof mockNotificationConfig>;
