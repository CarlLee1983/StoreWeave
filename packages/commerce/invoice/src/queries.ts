import { z } from 'zod';
import { PlatformError, defineQuery, type QueryContext } from '@storeweave/contracts';
import { getInvoiceInput, invoiceDto, listInvoicesInput, listInvoicesOutput } from './dto';
import { InvoiceRepository, toInvoiceDto } from './repository';

const repository = new InvoiceRepository();
export const getInvoiceQuery = defineQuery({ name: 'commerce.invoice.get', summary: '讀取一筆電子發票生命週期紀錄', input: getInvoiceInput, output: invoiceDto, permission: 'invoice:read' });
export const getInvoiceHandler = async (input: z.infer<typeof getInvoiceInput>, ctx: QueryContext) => {
  const row = await repository.findById(ctx.db, input.id); if (!row) throw PlatformError.notFound('Invoice', input.id); return toInvoiceDto(row);
};
export const listInvoicesQuery = defineQuery({ name: 'commerce.invoice.list', summary: '列出電子發票生命週期紀錄', input: listInvoicesInput, output: listInvoicesOutput, permission: 'invoice:read' });
export const listInvoicesHandler = async (input: z.infer<typeof listInvoicesInput>, ctx: QueryContext) => {
  const result = await repository.list(ctx.db, input); return { items: result.items.map(toInvoiceDto), total: result.total };
};

const issueSnapshotInput = z.object({ id: z.string().uuid() }).strict();
export const getInvoiceIssueSnapshotQuery = defineQuery({ name: 'commerce.invoice.issueSnapshot', summary: '背景工作讀取受保護的發票開立快照', input: issueSnapshotInput, output: z.object({ email: z.string().email(), name: z.string(), phone: z.string() }), permission: 'invoice:system-write' });
export const getInvoiceIssueSnapshotHandler = async (input: { id: string }, ctx: QueryContext) => {
  const row = await repository.findById(ctx.db, input.id); if (!row) throw PlatformError.notFound('Invoice', input.id); return row.customer;
};
export const getInvoiceIssueLinesQuery = defineQuery({ name: 'commerce.invoice.issueLines', summary: '背景工作讀取受保護的發票品項快照', input: issueSnapshotInput, output: z.array(z.object({ name: z.string(), quantity: z.number().int().positive(), unitPriceCents: z.number().int().positive(), amountCents: z.number().int().positive() })), permission: 'invoice:system-write' });
export const getInvoiceIssueLinesHandler = async (input: { id: string }, ctx: QueryContext) => {
  const row = await repository.findById(ctx.db, input.id); if (!row) throw PlatformError.notFound('Invoice', input.id); return row.lines;
};
