import { z } from 'zod';

export const invoiceCarrierDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ecpay') }),
  z.object({ kind: z.literal('mobile'), number: z.string() }),
  z.object({ kind: z.literal('natural_person'), number: z.string() }),
  z.object({ kind: z.literal('donation'), loveCode: z.string() }),
]);

export const invoiceDto = z.object({
  id: z.string().uuid(), orderId: z.string().uuid(), orderNumber: z.string(), provider: z.string(), reference: z.string(),
  currency: z.string().length(3), amountCents: z.number().int().positive(), taxCents: z.number().int().nonnegative(),
  carrier: invoiceCarrierDto, status: z.enum(['pending', 'issued', 'issue_failed', 'void_pending', 'voided', 'void_failed']),
  providerRef: z.string().nullable(), invoiceNumber: z.string().nullable(), invoiceDate: z.string().nullable(),
  issueAttempts: z.number().int().nonnegative(), voidAttempts: z.number().int().nonnegative(), lastError: z.string().nullable(),
  issuedAt: z.coerce.date().nullable(), voidedAt: z.coerce.date().nullable(), createdAt: z.coerce.date(), updatedAt: z.coerce.date(),
});
export type InvoiceDto = z.infer<typeof invoiceDto>;

export const queueInvoiceIssueInput = z.object({ eventId: z.string().uuid(), orderId: z.string().uuid() }).strict();
export const recordInvoiceIssueInput = z.object({
  id: z.string().uuid(), status: z.enum(['issued', 'issue_failed']), providerRef: z.string().min(1).max(200).optional(),
  invoiceNumber: z.string().min(1).max(50).optional(), invoiceDate: z.string().min(1).max(40).optional(),
  error: z.string().min(1).max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'issued' && (!value.providerRef || !value.invoiceNumber || !value.invoiceDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'providerRef, invoiceNumber and invoiceDate are required when issued' });
  }
  if (value.status === 'issue_failed' && !value.error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: 'required when issue_failed' });
});
export const queueInvoiceVoidInput = z.object({ refundId: z.string().uuid(), orderId: z.string().uuid(), amountCents: z.number().int().positive() }).strict();
export const recordInvoiceVoidInput = z.object({
  id: z.string().uuid(), status: z.enum(['voided', 'void_failed']), providerRef: z.string().min(1).max(200).optional(), error: z.string().min(1).max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'voided' && !value.providerRef) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providerRef'], message: 'required when voided' });
  if (value.status === 'void_failed' && !value.error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: 'required when void_failed' });
});
export const retryInvoiceIssueInput = z.object({ id: z.string().uuid() }).strict();
export const retryInvoiceVoidInput = z.object({ id: z.string().uuid() }).strict();
export const getInvoiceInput = z.object({ id: z.string().uuid() }).strict();
export const listInvoicesInput = z.object({ orderId: z.string().uuid().optional(), status: invoiceDto.shape.status.optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict();
export const listInvoicesOutput = z.object({ items: z.array(invoiceDto), total: z.number().int().nonnegative() });
