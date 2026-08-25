import { createHash } from 'node:crypto';
import type { ExtensionContext, InvoiceIssueInput, InvoiceIssueResult, InvoiceProvider, InvoiceVoidInput, InvoiceVoidResult } from '@storeweave/extension-sdk';
import type { MockInvoiceConfig } from './config';
export const MOCK_INVOICE_PROVIDER_ID = 'mock-invoice';
interface MockInvoice { providerRef: string; invoiceNumber: string; invoiceDate: string; voided: boolean; }
export function createMockInvoiceProvider(ctx: ExtensionContext<MockInvoiceConfig>): InvoiceProvider {
  return { id: MOCK_INVOICE_PROVIDER_ID, kind: 'invoice',
    async validateLoveCode(loveCode) { return ctx.config.validLoveCodes.includes(loveCode); },
    async issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult> {
      const key = `invoice:${input.reference}`; const existing = await ctx.store.get<MockInvoice>(key);
      if (existing) return { status: 'issued', providerRef: existing.providerRef, invoiceNumber: existing.invoiceNumber, invoiceDate: existing.invoiceDate };
      if (!ctx.config.issue) return { status: 'rejected', message: 'mock issue disabled' };
      const invoiceNumber = `MI${createHash('sha256').update(input.reference).digest('hex').slice(0, 8).toUpperCase()}`;
      const record = { providerRef: `mock_${invoiceNumber}`, invoiceNumber, invoiceDate: ctx.now().toISOString().slice(0, 19).replace('T', ' '), voided: false };
      await ctx.store.set(key, record); return { status: 'issued', providerRef: record.providerRef, invoiceNumber, invoiceDate: record.invoiceDate };
    },
    async void(input: InvoiceVoidInput): Promise<InvoiceVoidResult> {
      if (!ctx.config.void) return { status: 'rejected', message: 'mock void disabled' };
      return { status: 'voided', providerRef: input.providerRef };
    },
  };
}
