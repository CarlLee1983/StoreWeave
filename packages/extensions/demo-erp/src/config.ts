import { z } from 'zod';

export const demoErpConfig = z.object({
  /** `mock://` 走內建的模擬 ERP；`http(s)://` 會實際發出請求。 */
  endpoint: z.string().default('mock://demo-erp'),
  companyCode: z.string().min(1).default('DEMO'),
  warehouseCode: z.string().min(1).default('MAIN'),
  documentType: z.string().min(1).default('SALES_ORDER'),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  maxAttempts: z.number().int().min(1).max(20).default(5),
  /** 測試用：每個 reference 的前 N 次推送強制失敗，用來驗證重試行為。 */
  simulateTransientFailures: z.number().int().min(0).max(10).default(0),
});

export type DemoErpConfig = z.infer<typeof demoErpConfig>;

export const DEMO_ERP_API_KEY = 'DEMO_ERP_API_KEY';
export const ERP_PROVIDER_ID = 'demo-erp';
export const PUSH_ORDER_JOB = 'ext.demo-erp.push-order';
