import { z } from 'zod';

export const lifecycleTemplate = z.enum([
  'customer.order-placed', 'customer.order-paid', 'customer.shipment-shipped', 'customer.shipment-arrived',
]);

export const lifecycleDeliveryDto = z.object({
  id: z.string().uuid(), eventId: z.string().uuid(), orderId: z.string().uuid(), template: lifecycleTemplate,
  reference: z.string(), recipientEmail: z.string().email(), variables: z.record(z.unknown()),
  status: z.enum(['pending', 'sent', 'failed']), providerRef: z.string().nullable(), attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(), sentAt: z.coerce.date().nullable(), createdAt: z.coerce.date(), updatedAt: z.coerce.date(),
});
export type LifecycleDeliveryDto = z.infer<typeof lifecycleDeliveryDto>;

export const queueLifecycleDeliveryInput = z.object({
  eventId: z.string().uuid(), orderId: z.string().uuid(), template: lifecycleTemplate,
  variables: z.record(z.unknown()),
}).strict();

export const recordLifecycleDeliveryInput = z.object({
  id: z.string().uuid(), status: z.enum(['sent', 'failed']), providerRef: z.string().min(1).max(200),
  error: z.string().min(1).max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'failed' && !value.error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: 'required for failed delivery' });
});

export const listLifecycleDeliveriesInput = z.object({
  orderId: z.string().uuid().optional(), status: z.enum(['pending', 'sent', 'failed']).optional(),
  limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0),
}).strict();
/**
 * 營運頁看得到的形狀：收件人只給遮蔽值，`variables` 整個不給。
 * 那份 payload 帶顧客姓名與訂單細節，而營運要回答的問題只是「送了沒、為什麼失敗」。
 */
export const lifecycleDeliverySummaryDto = lifecycleDeliveryDto
  .omit({ recipientEmail: true, variables: true })
  .extend({ recipientMasked: z.string() });
export type LifecycleDeliverySummaryDto = z.infer<typeof lifecycleDeliverySummaryDto>;

export const listLifecycleDeliveriesOutput = z.object({ items: z.array(lifecycleDeliverySummaryDto), total: z.number().int().nonnegative() });
