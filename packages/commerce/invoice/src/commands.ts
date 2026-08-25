import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, defineCommand, type CommandContext, type DrizzleDb, type Tx } from '@storeweave/contracts';
import type { InvoiceCarrier, InvoiceIssueInput, ProviderRegistry } from '@storeweave/extension-sdk';
import { InvoiceRepository, toInvoiceDto } from './repository';
import { invoiceDto, queueInvoiceIssueInput, retryInvoiceIssueInput, retryInvoiceVoidInput, queueInvoiceVoidInput, recordInvoiceIssueInput, recordInvoiceVoidInput, type InvoiceDto } from './dto';

export const ISSUE_INVOICE_JOB = 'commerce.invoice.issue';
export const VOID_INVOICE_JOB = 'commerce.invoice.void';
const repository = new InvoiceRepository();

export interface InvoiceOrderLookup {
  invoiceForIssue(db: DrizzleDb | Tx, orderId: string): Promise<Omit<InvoiceIssueInput, 'invoiceId' | 'reference'> | null>;
}

export const queueInvoiceIssueCommand = defineCommand({
  name: 'commerce.invoice.queueIssue', summary: '建立付款成功後的電子發票開立工作', input: queueInvoiceIssueInput, output: invoiceDto,
  permission: 'invoice:system-write', idempotency: 'required',
});

export function createQueueInvoiceIssueHandler(orders: InvoiceOrderLookup, providers: ProviderRegistry) {
  return async (input: z.infer<typeof queueInvoiceIssueInput>, ctx: CommandContext): Promise<InvoiceDto> => {
    const existing = await repository.findByEventId(ctx.tx, input.eventId);
    if (existing) return toInvoiceDto(existing);
    const snapshot = await orders.invoiceForIssue(ctx.tx, input.orderId);
    if (!snapshot) throw PlatformError.notFound('PaidOrder', input.orderId);
    if (snapshot.currency !== 'TWD' || snapshot.amountCents % 100 !== 0) {
      throw PlatformError.validation('ECPay B2C invoices require a whole-TWD paid order');
    }
    const id = randomUUID();
    const row = await repository.insert(ctx.tx, {
      id, eventId: input.eventId, orderId: input.orderId, orderNumber: snapshot.orderNumber, provider: providers.get('invoice').id, reference: `invoice:${id}`,
      currency: snapshot.currency, amountCents: snapshot.amountCents,
      // The merchant selected a 5% tax-inclusive price policy. `taxCents` is
      // retained separately for audit while ECPay receives inclusive item prices.
      taxCents: Math.round(snapshot.amountCents * 5 / 105), customer: snapshot.customer,
      carrier: snapshot.carrier, lines: snapshot.lines, status: 'pending', issueAttempts: 0, voidAttempts: 0,
      createdAt: ctx.now, updatedAt: ctx.now,
    });
    if (!row) {
      const concurrent = await repository.findByEventId(ctx.tx, input.eventId);
      if (!concurrent) throw PlatformError.internal('Invoice disappeared after conflict');
      return toInvoiceDto(concurrent);
    }
    await ctx.enqueue({ type: ISSUE_INVOICE_JOB, payload: { invoiceId: row.id }, dedupeKey: `invoice:issue:${row.id}` });
    return toInvoiceDto(row);
  };
}

export const recordInvoiceIssueCommand = defineCommand({
  name: 'commerce.invoice.recordIssue', summary: '記錄電子發票開立結果', input: recordInvoiceIssueInput, output: invoiceDto,
  permission: 'invoice:system-write', idempotency: 'required',
});

export const recordInvoiceIssueHandler = async (input: z.infer<typeof recordInvoiceIssueInput>, ctx: CommandContext): Promise<InvoiceDto> => {
  if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only invoice workers may record issue results');
  const row = await repository.lockById(ctx.tx, input.id);
  if (!row) throw PlatformError.notFound('Invoice', input.id);
  if (row.status === 'issued') {
    if (input.status !== 'issued' || input.invoiceNumber !== row.invoiceNumber) throw PlatformError.conflict(`Invoice ${row.id} already has different issue evidence`);
    return toInvoiceDto(row);
  }
  if (!['pending', 'issue_failed'].includes(row.status)) throw PlatformError.conflict(`Invoice ${row.id} cannot record issue result from ${row.status}`);
  const updated = await repository.update(ctx.tx, row.id, input.status === 'issued'
    ? { status: 'issued', providerRef: input.providerRef!, invoiceNumber: input.invoiceNumber!, invoiceDate: input.invoiceDate!, issueAttempts: row.issueAttempts + 1, lastError: null, issuedAt: ctx.now, updatedAt: ctx.now }
    : { status: 'issue_failed', issueAttempts: row.issueAttempts + 1, lastError: input.error!, updatedAt: ctx.now });
  if (!updated) throw PlatformError.internal(`Invoice ${row.id} disappeared`);
  return toInvoiceDto(updated);
};

export const queueInvoiceVoidCommand = defineCommand({
  name: 'commerce.invoice.queueVoid', summary: '全額退款後排入電子發票作廢', input: queueInvoiceVoidInput, output: invoiceDto.nullable(),
  permission: 'invoice:system-write', idempotency: 'required',
});

export const queueInvoiceVoidHandler = async (input: z.infer<typeof queueInvoiceVoidInput>, ctx: CommandContext): Promise<InvoiceDto | null> => {
  // Find by the unique order key, then lock the actual invoice row before
  // deciding whether this completed refund is a full-refund void.
  const existing = await repository.findByOrderId(ctx.tx, input.orderId);
  if (!existing) return null;
  const invoice = await repository.lockById(ctx.tx, existing.id);
  if (!invoice) return null;
  // Merchant policy: partial refunds neither void nor create an allowance.
  if (input.amountCents !== invoice.amountCents || invoice.status !== 'issued') return toInvoiceDto(invoice);
  const updated = await repository.update(ctx.tx, invoice.id, { status: 'void_pending', voidAttempts: invoice.voidAttempts, lastError: null, updatedAt: ctx.now });
  if (!updated) throw PlatformError.internal(`Invoice ${invoice.id} disappeared`);
  await ctx.enqueue({ type: VOID_INVOICE_JOB, payload: { invoiceId: updated.id }, dedupeKey: `invoice:void:${updated.id}` });
  return toInvoiceDto(updated);
};

export const recordInvoiceVoidCommand = defineCommand({
  name: 'commerce.invoice.recordVoid', summary: '記錄電子發票作廢結果', input: recordInvoiceVoidInput, output: invoiceDto,
  permission: 'invoice:system-write', idempotency: 'required',
});

export const recordInvoiceVoidHandler = async (input: z.infer<typeof recordInvoiceVoidInput>, ctx: CommandContext): Promise<InvoiceDto> => {
  if (ctx.actor.type !== 'system') throw PlatformError.forbidden('Only invoice workers may record void results');
  const row = await repository.lockById(ctx.tx, input.id);
  if (!row) throw PlatformError.notFound('Invoice', input.id);
  if (row.status === 'voided') {
    if (input.status !== 'voided') throw PlatformError.conflict(`Invoice ${row.id} already voided`);
    return toInvoiceDto(row);
  }
  if (!['void_pending', 'void_failed'].includes(row.status)) throw PlatformError.conflict(`Invoice ${row.id} cannot record void result from ${row.status}`);
  const updated = await repository.update(ctx.tx, row.id, input.status === 'voided'
    ? { status: 'voided', providerRef: input.providerRef!, voidAttempts: row.voidAttempts + 1, lastError: null, voidedAt: ctx.now, updatedAt: ctx.now }
    : { status: 'void_failed', voidAttempts: row.voidAttempts + 1, lastError: input.error!, updatedAt: ctx.now });
  if (!updated) throw PlatformError.internal(`Invoice ${row.id} disappeared`);
  return toInvoiceDto(updated);
};

export const retryInvoiceIssueCommand = defineCommand({
  name: 'commerce.invoice.retryIssue', summary: '營運人員重送失敗的電子發票開立', input: retryInvoiceIssueInput, output: invoiceDto,
  permission: 'invoice:write', idempotency: 'required',
  audit: { action: 'invoice.issue-retried', resourceType: 'invoice', resourceId: (input: { id: string }) => input.id, redact: (input: { id: string }) => ({ id: input.id }) },
});

export const retryInvoiceIssueHandler = async (input: z.infer<typeof retryInvoiceIssueInput>, ctx: CommandContext): Promise<InvoiceDto> => {
  const row = await repository.lockById(ctx.tx, input.id);
  if (!row) throw PlatformError.notFound('Invoice', input.id);
  // `pending` is included on purpose: a provider exception leaves the record
  // there with its job dead, and that is exactly the state an operator needs
  // to be able to push out of.
  if (!['pending', 'issue_failed'].includes(row.status)) throw PlatformError.conflict(`Invoice ${row.id} cannot be re-attempted from ${row.status}`);
  // Re-schedule the one job this invoice owns rather than adding a second.
  // A fresh key would let a manual retry run beside an automatic retry that is
  // still backing off, and two live jobs can issue two invoices at ECPay.
  await ctx.enqueue({ type: ISSUE_INVOICE_JOB, payload: { invoiceId: row.id }, dedupeKey: `invoice:issue:${row.id}`, replaceExisting: true });
  return toInvoiceDto(row);
};

export const retryInvoiceVoidCommand = defineCommand({
  name: 'commerce.invoice.retryVoid', summary: '營運人員重送失敗的電子發票作廢', input: retryInvoiceVoidInput, output: invoiceDto,
  permission: 'invoice:write', idempotency: 'required',
  audit: { action: 'invoice.void-retried', resourceType: 'invoice', resourceId: (input: { id: string }) => input.id, redact: (input: { id: string }) => ({ id: input.id }) },
});

export const retryInvoiceVoidHandler = async (input: z.infer<typeof retryInvoiceVoidInput>, ctx: CommandContext): Promise<InvoiceDto> => {
  const row = await repository.lockById(ctx.tx, input.id);
  if (!row) throw PlatformError.notFound('Invoice', input.id);
  // `void_pending` is included for the same reason as `pending` above: a
  // provider exception never reaches recordVoid, so the record would otherwise
  // be stuck in a state no operator action can leave.
  if (!['void_pending', 'void_failed'].includes(row.status)) throw PlatformError.conflict(`Invoice ${row.id} cannot be re-attempted from ${row.status}`);
  // The void job only runs from void_pending; a retry is what puts the record
  // back in flight. The decision that this invoice should be voided was
  // already made by the full refund that queued it. `lastError` stays until a
  // new result lands — clearing it first would erase the only explanation the
  // operator has if this attempt also fails to report back.
  const updated = await repository.update(ctx.tx, row.id, { status: 'void_pending', updatedAt: ctx.now });
  if (!updated) throw PlatformError.internal(`Invoice ${row.id} disappeared`);
  await ctx.enqueue({ type: VOID_INVOICE_JOB, payload: { invoiceId: row.id }, dedupeKey: `invoice:void:${row.id}`, replaceExisting: true });
  return toInvoiceDto(updated);
};
