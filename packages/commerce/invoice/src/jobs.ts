import { z } from 'zod';
import { PermanentJobError, type JobHandler } from '@storeweave/jobs';
import type { InvoiceProvider, ProviderRegistry } from '@storeweave/extension-sdk';
import type { InvoiceDto } from './dto';

const payload = z.object({ invoiceId: z.string().uuid() });

export function createIssueInvoiceJob(providers: ProviderRegistry): JobHandler {
  return async (raw, ctx) => {
    const { invoiceId } = payload.parse(raw);
    if (!ctx.executeQuery || !ctx.executeCommand) throw new PermanentJobError('Invoice issue job lacks core bus access');
    const invoice = await ctx.executeQuery('commerce.invoice.get', { id: invoiceId }) as InvoiceDto;
    if (invoice.status === 'issued' || invoice.status === 'void_pending' || invoice.status === 'voided') return;
    const provider = providers.get<InvoiceProvider>('invoice', invoice.provider);
    if (invoice.carrier.kind === 'donation' && !(await provider.validateLoveCode(invoice.carrier.loveCode))) {
      await ctx.executeCommand('commerce.invoice.recordIssue', { id: invoice.id, status: 'issue_failed', error: 'ECPay rejected the donation love code' }, `invoice:issue:${invoice.id}:invalid-love-code`);
      throw new PermanentJobError('ECPay rejected the donation love code');
    }
    const result = await provider.issue({ invoiceId: invoice.id, reference: invoice.reference, orderId: invoice.orderId, orderNumber: invoice.orderNumber,
      currency: invoice.currency, amountCents: invoice.amountCents, taxCents: invoice.taxCents,
      customer: (await invoiceCustomer(ctx, invoice.id)), carrier: invoice.carrier, lines: await invoiceLines(ctx, invoice.id) });
    if (result.status === 'issued') {
      await ctx.executeCommand('commerce.invoice.recordIssue', { id: invoice.id, status: 'issued', providerRef: result.providerRef, invoiceNumber: result.invoiceNumber, invoiceDate: result.invoiceDate }, `invoice:issue:${invoice.id}:issued:${result.invoiceNumber}`);
      return;
    }
    await ctx.executeCommand('commerce.invoice.recordIssue', { id: invoice.id, status: 'issue_failed', error: result.message }, `invoice:issue:${invoice.id}:failed:${invoice.issueAttempts}:${ctx.attempt}`);
    throw new Error(result.message);
  };
}

export function createVoidInvoiceJob(providers: ProviderRegistry): JobHandler {
  return async (raw, ctx) => {
    const { invoiceId } = payload.parse(raw);
    if (!ctx.executeQuery || !ctx.executeCommand) throw new PermanentJobError('Invoice void job lacks core bus access');
    const invoice = await ctx.executeQuery('commerce.invoice.get', { id: invoiceId }) as InvoiceDto;
    if (invoice.status === 'voided') return;
    if (invoice.status !== 'void_pending' || !invoice.providerRef || !invoice.invoiceNumber || !invoice.invoiceDate) throw new PermanentJobError(`Invoice ${invoice.id} cannot be voided from ${invoice.status}`);
    const provider = providers.get<InvoiceProvider>('invoice', invoice.provider);
    const result = await provider.void({ invoiceId: invoice.id, reference: `void:${invoice.reference}`, providerRef: invoice.providerRef, invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, reason: 'full refund' });
    if (result.status === 'voided') {
      await ctx.executeCommand('commerce.invoice.recordVoid', { id: invoice.id, status: 'voided', providerRef: result.providerRef }, `invoice:void:${invoice.id}:voided:${result.providerRef}`);
      return;
    }
    await ctx.executeCommand('commerce.invoice.recordVoid', { id: invoice.id, status: 'void_failed', error: result.message }, `invoice:void:${invoice.id}:failed:${invoice.voidAttempts}:${ctx.attempt}`);
    throw new Error(result.message);
  };
}

// Invoice DTO deliberately omits customer details and lines from query output.
// Provider jobs retrieve the protected snapshot through a system-only query.
async function invoiceCustomer(ctx: Parameters<JobHandler>[1], id: string) {
  return await ctx.executeQuery!('commerce.invoice.issueSnapshot', { id }) as { email: string; name: string; phone: string };
}
async function invoiceLines(ctx: Parameters<JobHandler>[1], id: string) {
  return await ctx.executeQuery!('commerce.invoice.issueLines', { id }) as { name: string; quantity: number; unitPriceCents: number; amountCents: number }[];
}
