import { z } from 'zod';

export const deliveryStatus = z.enum(['pending', 'sent', 'failed']);

/** 每張訂單一筆投遞紀錄：成功、失敗、重試次數、最後錯誤。 */
export const deliveryRecord = z.object({
  orderId: z.string(),
  orderNumber: z.string(),
  reference: z.string(),
  status: deliveryStatus,
  attempts: z.number().int().nonnegative(),
  manualResends: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  remoteId: z.string().nullable(),
  jobId: z.string().nullable(),
  firstSeenAt: z.string(),
  updatedAt: z.string(),
});

export type DeliveryRecord = z.infer<typeof deliveryRecord>;

export function deliveryKey(orderId: string): string {
  return `delivery:${orderId}`;
}

export function erpReference(orderNumber: string): string {
  return `SO-${orderNumber}`;
}
