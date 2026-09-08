import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Invoice } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { deadJobKeys, healthKeys, invoiceKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperationEntries, useAdminOperations } from '../admin-operations';

const STATUSES: Invoice['status'][] = ['pending', 'issued', 'issue_failed', 'void_pending', 'voided', 'void_failed'];
type InvoiceOperation = AdminOperation & { kind: 'retry-issue' | 'retry-void'; invoiceId: string };
const invoiceScope = (id: string) => `invoice:${id}`;
const isInvoiceOperationEntry = (entry: AdminOperationEntry): entry is AdminOperationEntry<InvoiceOperation> => entry.operation.area === 'invoice' && entry.operation.scope.startsWith('invoice:') && 'kind' in entry.operation && (entry.operation.kind === 'retry-issue' || entry.operation.kind === 'retry-void');

function carrierLabel(carrier: Invoice['carrier'], t: (key: 'carrierMobile' | 'carrierNaturalPerson' | 'carrierDonation' | 'carrierMember') => string): string {
  switch (carrier.kind) {
    case 'mobile': return `${t('carrierMobile')} ${carrier.number}`;
    case 'natural_person': return `${t('carrierNaturalPerson')} ${carrier.number}`;
    case 'donation': return `${t('carrierDonation')} ${carrier.loveCode}`;
    default: return t('carrierMember');
  }
}

function useInvoiceCommand() {
  const store = useAdminOperations();
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationKey: ['invoice', 'command'] as const, mutationFn: (operation: InvoiceOperation) => operation.kind === 'retry-issue' ? api.retryInvoiceIssue(operation.invoiceId, operation.idempotencyKey) : api.retryInvoiceVoid(operation.invoiceId, operation.idempotencyKey) });
  return (operation: InvoiceOperation, recovery?: AdminOperationEntry<InvoiceOperation>) => executeAdminOperation(store, operation, mutation.mutateAsync, (_result, live) => {
    void queryClient.invalidateQueries({ queryKey: invoiceKeys.lists });
    void queryClient.invalidateQueries({ queryKey: invoiceKeys.detail(live.invoiceId) });
    void queryClient.invalidateQueries({ queryKey: deadJobKeys.lists });
    void queryClient.invalidateQueries({ queryKey: healthKeys.dependencies });
    return undefined;
  }, recovery);
}

export function InvoicesPage() {
  const { t, statusLabel, formatMoney } = useI18n();
  const [status, setStatus] = useState<Invoice['status'] | ''>('');
  const [terminalError, setTerminalError] = useState<unknown>(null);
  const input = { ...(status === '' ? {} : { status }), limit: 50, offset: 0 };
  const invoicesQuery = useQuery({ queryKey: invoiceKeys.list(input), queryFn: ({ signal }) => api.listInvoices(input, signal) });
  const recoveries = useAdminOperationEntries().filter(isInvoiceOperationEntry);

  return <section>
    {terminalError ? <ErrorBanner error={terminalError} onDismiss={() => setTerminalError(null)} /> : null}
    {recoveries.map((entry) => <InvoiceRecovery key={entry.operation.idempotencyKey} entry={entry} onTerminalError={setTerminalError} />)}
    {invoicesQuery.isError ? <ErrorBanner error={invoicesQuery.error} onRetry={() => void invoicesQuery.refetch()} /> : null}
    <p className="muted">{t('invoiceActivityHint')}</p>
    <div className="inline-form"><label>{t('invoiceStatus')}<select aria-label={t('invoiceStatus')} value={status} onChange={(event) => setStatus(event.target.value as Invoice['status'] | '')}><option value="">{t('allInvoiceStatuses')}</option>{STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label></div>
    {invoicesQuery.isLoading ? <Loading /> : invoicesQuery.isSuccess && invoicesQuery.data.items.length === 0 ? <EmptyState icon="receipt" title={t('noInvoices')} /> : invoicesQuery.isSuccess ? <div className="table-wrap"><table className="data-table data-table--fixed observability-table">
      <thead><tr><th style={{ width: '13%' }}>{t('orders')}</th><th style={{ width: '10%' }}>{t('status')}</th><th style={{ width: '10%' }}>{t('invoiceNumber')}</th><th style={{ width: '11%' }}>{t('invoiceDate')}</th><th style={{ width: '11%' }}>{t('carrier')}</th><th style={{ width: '14%' }} className="col-numeric">{t('taxAmount')}</th><th style={{ width: '7%' }} className="col-numeric">{t('attempts')}</th><th style={{ width: '12%' }}>{t('lastError')}</th><th style={{ width: '12%' }} className="col-actions">{t('actions')}</th></tr></thead>
      <tbody>{invoicesQuery.data.items.map((invoice) => <InvoiceRow key={invoice.id} invoice={invoice} formatMoney={formatMoney} onTerminalError={setTerminalError} />)}</tbody>
    </table></div> : null}
  </section>;
}

function InvoiceRow({ invoice, formatMoney, onTerminalError }: { invoice: Invoice; formatMoney: (cents: number, currency: string) => string; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const command = useInvoiceCommand();
  const entry = useAdminOperationEntries().filter(isInvoiceOperationEntry).find((candidate) => candidate.operation.scope === invoiceScope(invoice.id));
  const retry = async (kind: InvoiceOperation['kind']) => {
    const operation: InvoiceOperation = { area: 'invoice', scope: invoiceScope(invoice.id), kind, invoiceId: invoice.id, idempotencyKey: crypto.randomUUID() };
    const result = await command(operation, entry?.phase === 'unknown' && entry.operation.kind === kind ? entry : undefined);
    if (result.state === 'rejected') onTerminalError(result.error);
  };
  const locked = !!entry;
  return <tr>
    <td className="mono">{invoice.orderNumber}</td><td><StatusBadge value={invoice.status} /></td><td className="mono">{invoice.invoiceNumber ?? t('none')}</td><td>{invoice.invoiceDate ?? t('none')}</td><td><span className="cell-truncate" title={carrierLabel(invoice.carrier, t)}>{carrierLabel(invoice.carrier, t)}</span></td><td className="col-numeric">{formatMoney(invoice.amountCents, invoice.currency)} / {formatMoney(invoice.taxCents, invoice.currency)}</td><td className="col-numeric">{invoice.issueAttempts} / {invoice.voidAttempts}</td><td>{invoice.lastError ? <span className="cell-truncate" title={invoice.lastError}>{invoice.lastError}</span> : t('none')}</td>
    <td className="col-actions">
      {invoice.status === 'issue_failed' || invoice.status === 'pending' ? <button className="button button--primary" type="button" disabled={locked} onClick={() => void retry('retry-issue')} title={t('retryIssue')} aria-label={t('retryIssue')}><Icon name="send" /> {t('resend')}</button> : null}
      {invoice.status === 'void_failed' || invoice.status === 'void_pending' ? <button className="button button--primary" type="button" disabled={locked} onClick={() => void retry('retry-void')} title={t('retryVoid')} aria-label={t('retryVoid')}><Icon name="send" /> {t('resend')}</button> : null}
    </td>
  </tr>;
}

function InvoiceRecovery({ entry, onTerminalError }: { entry: AdminOperationEntry<InvoiceOperation>; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const command = useInvoiceCommand();
  const [submitting, setSubmitting] = useState(false);
  const retry = async () => { setSubmitting(true); const result = await command(entry.operation, entry); if (result.state === 'rejected') onTerminalError(result.error); setSubmitting(false); };
  return <section className="account-panel" aria-label={entry.operation.kind === 'retry-issue' ? t('retryIssue') : t('retryVoid')}><div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('operationPending') : t('unknownError')}</strong>{entry.phase === 'unknown' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}</div><dl className="order-totals"><dt>{t('invoiceNumber')}</dt><dd className="mono">{entry.operation.invoiceId}</dd></dl></section>;
}
