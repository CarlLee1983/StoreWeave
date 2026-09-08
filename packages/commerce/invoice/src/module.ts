import packageJson from '../package.json';
import { type BoundModuleCapability, defineModule, type PlatformModule } from '@storeweave/kernel';
import type { ProviderRegistry } from '@storeweave/extension-sdk';
import { orderPaidV2 } from '@storeweave/order';
import { refundSucceededV1 } from '@storeweave/refund';
import { createQueueInvoiceIssueHandler, ISSUE_INVOICE_JOB, queueInvoiceIssueCommand, queueInvoiceVoidCommand, queueInvoiceVoidHandler, recordInvoiceIssueCommand, recordInvoiceIssueHandler, recordInvoiceVoidCommand, recordInvoiceVoidHandler, retryInvoiceIssueCommand, retryInvoiceIssueHandler, retryInvoiceVoidCommand, retryInvoiceVoidHandler, VOID_INVOICE_JOB, type InvoiceOrderLookup } from './commands';
import { invoiceMigrations } from './migrations';
import { createIssueInvoiceJob, createVoidInvoiceJob } from './jobs';
import { getInvoiceHandler, getInvoiceIssueLinesHandler, getInvoiceIssueLinesQuery, getInvoiceIssueSnapshotHandler, getInvoiceIssueSnapshotQuery, getInvoiceQuery, listInvoicesHandler, listInvoicesQuery } from './queries';

export function createInvoiceModule(ordersBinding: BoundModuleCapability<InvoiceOrderLookup>, providers: ProviderRegistry): PlatformModule {
  const orders = ordersBinding.value;

  return defineModule({ name: 'invoice',
  version: packageJson.version,
  baseVersionRange: '^1.0.0',
  dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
  capabilities: {
    required: [
      { from: 'order', capability: 'commerce.order.invoice-lookup', versionRange: '^0.1.0' },
    ],
    bound: [ordersBinding],
  },
  data: { owns: ['invoice_invoices'] }, migrations: invoiceMigrations,
    permissions: [
      { key: 'invoice:read', description: '讀取電子發票生命週期紀錄', owner: 'invoice' },
      { key: 'invoice:write', description: '營運人員重送失敗的電子發票作業', owner: 'invoice' },
      { key: 'invoice:system-write', description: '背景工作記錄電子發票外部結果', owner: 'invoice' },
    ],
    commands: [
      { descriptor: queueInvoiceIssueCommand, handler: createQueueInvoiceIssueHandler(orders, providers) },
      { descriptor: recordInvoiceIssueCommand, handler: recordInvoiceIssueHandler },
      { descriptor: queueInvoiceVoidCommand, handler: queueInvoiceVoidHandler },
      { descriptor: recordInvoiceVoidCommand, handler: recordInvoiceVoidHandler },
      { descriptor: retryInvoiceIssueCommand, handler: retryInvoiceIssueHandler },
      { descriptor: retryInvoiceVoidCommand, handler: retryInvoiceVoidHandler },
    ],
    queries: [
      { descriptor: getInvoiceQuery, handler: getInvoiceHandler }, { descriptor: listInvoicesQuery, handler: listInvoicesHandler },
      { descriptor: getInvoiceIssueSnapshotQuery, handler: getInvoiceIssueSnapshotHandler }, { descriptor: getInvoiceIssueLinesQuery, handler: getInvoiceIssueLinesHandler },
    ],
    jobs: [{ type: ISSUE_INVOICE_JOB, handler: createIssueInvoiceJob(providers) }, { type: VOID_INVOICE_JOB, handler: createVoidInvoiceJob(providers) }],
    subscribers: [
      { eventName: orderPaidV2.name, handler: async (event, ctx) => {
        if (!providers.has('invoice') || !ctx.executeCommand) return;
        await ctx.executeCommand('commerce.invoice.queueIssue', { eventId: event.id, orderId: event.payload.orderId }, `invoice:queue:${event.id}`);
      } },
      { eventName: refundSucceededV1.name, handler: async (event, ctx) => {
        if (!providers.has('invoice') || !ctx.executeCommand) return;
        const p = event.payload;
        await ctx.executeCommand('commerce.invoice.queueVoid', { refundId: p.refundId, orderId: p.orderId, amountCents: p.amountCents }, `invoice:void-queue:${p.refundId}`);
      } },
    ],
  });
}
