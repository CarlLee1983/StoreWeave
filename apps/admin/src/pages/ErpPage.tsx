import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Delivery } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { EmptyState } from '../components/EmptyState';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { deadJobKeys, erpDeliveryKeys, healthKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperationEntries, useAdminOperations } from '../admin-operations';

type ErpOperation = AdminOperation & { kind: 'resend'; orderId: string };
const erpScope = (id: string) => `erp-delivery:${id}`;
const isErpOperationEntry = (entry: AdminOperationEntry): entry is AdminOperationEntry<ErpOperation> => entry.operation.area === 'erp-delivery' && entry.operation.scope.startsWith('erp-delivery:') && 'kind' in entry.operation && entry.operation.kind === 'resend';

function useErpCommand() {
  const store = useAdminOperations();
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationKey: ['erp-delivery', 'command'] as const, mutationFn: (operation: ErpOperation) => api.resendOrder(operation.orderId, operation.idempotencyKey) });
  return (operation: ErpOperation, recovery?: AdminOperationEntry<ErpOperation>) => executeAdminOperation(store, operation, mutation.mutateAsync, () => {
    void queryClient.invalidateQueries({ queryKey: erpDeliveryKeys.lists });
    void queryClient.invalidateQueries({ queryKey: deadJobKeys.lists });
    void queryClient.invalidateQueries({ queryKey: healthKeys.dependencies });
    return undefined;
  }, recovery);
}

export function ErpPage() {
  const { t } = useI18n();
  const [inspectedDelivery, setInspectedDelivery] = useState<{ delivery: Delivery; returnFocus: HTMLElement | null } | null>(null);
  const [terminalError, setTerminalError] = useState<unknown>(null);
  const input = { limit: 50 };
  const deliveriesQuery = useQuery({ queryKey: erpDeliveryKeys.list(input), queryFn: ({ signal }) => api.listDeliveries(input.limit, signal) });
  const recoveries = useAdminOperationEntries().filter(isErpOperationEntry);
  const visibleRecoveries = recoveries.filter((entry) => entry.operation.orderId !== inspectedDelivery?.delivery.orderId);

  return <section>
    {terminalError ? <ErrorBanner error={terminalError} onDismiss={() => setTerminalError(null)} /> : null}
    {visibleRecoveries.map((entry) => <ErpRecovery key={entry.operation.idempotencyKey} entry={entry} onTerminalError={setTerminalError} />)}
    {deliveriesQuery.isError ? <ErrorBanner error={deliveriesQuery.error} onRetry={() => void deliveriesQuery.refetch()} /> : null}
    {deliveriesQuery.isLoading ? <Loading /> : deliveriesQuery.isSuccess && deliveriesQuery.data.items.length === 0 ? <EmptyState icon="activity" title={t('noErpDeliveries')} /> : deliveriesQuery.isSuccess ? <div className="table-wrap"><table className="data-table data-table--fixed erp-deliveries-table">
      <thead><tr><th scope="col" style={{ width: '13%' }}>{t('orderNumber')}</th><th scope="col" style={{ width: '13%' }}>{t('reference')}</th><th scope="col" style={{ width: '9%' }}>{t('status')}</th><th scope="col" style={{ width: '8%' }} className="col-numeric" title={t('attempts')}>{t('attempts')}</th><th scope="col" style={{ width: '11%' }} className="col-numeric" title={t('manualResends')}>{t('manualResends')}</th><th scope="col" style={{ width: '20%' }}>{t('lastError')}</th><th scope="col" style={{ width: '12%' }}>{t('remoteId')}</th><th scope="col" style={{ width: '14%' }} className="col-actions">{t('actions')}</th></tr></thead>
      <tbody>{deliveriesQuery.data.items.map((delivery) => <DeliveryRow key={delivery.orderId} delivery={delivery} onInspect={(next, returnFocus) => setInspectedDelivery({ delivery: next, returnFocus })} onTerminalError={setTerminalError} />)}</tbody>
    </table></div> : null}
    {inspectedDelivery ? <PayloadDrawer delivery={inspectedDelivery.delivery} returnFocus={inspectedDelivery.returnFocus} onClose={() => setInspectedDelivery(null)} onTerminalError={setTerminalError} /> : null}
  </section>;
}

function DeliveryRow({ delivery, onInspect, onTerminalError }: { delivery: Delivery; onInspect: (delivery: Delivery, returnFocus: HTMLElement | null) => void; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const command = useErpCommand();
  const entry = useAdminOperationEntries().filter(isErpOperationEntry).find((candidate) => candidate.operation.scope === erpScope(delivery.orderId));
  const resend = async () => {
    const operation: ErpOperation = { area: 'erp-delivery', scope: erpScope(delivery.orderId), kind: 'resend', orderId: delivery.orderId, idempotencyKey: crypto.randomUUID() };
    const result = await command(operation, entry?.phase === 'unknown' ? entry : undefined);
    if (result.state === 'rejected') onTerminalError(result.error);
  };
  const menuItems: RowMenuItem[] = [{ key: 'resend', label: t('resend'), icon: 'send', onSelect: () => void resend() }];
  return <tr>
    <td className="mono">{delivery.orderNumber}</td><td><span className="cell-truncate" title={delivery.reference}>{delivery.reference}</span></td><td><StatusBadge value={delivery.status} /></td><td className="col-numeric">{delivery.attempts}</td><td className="col-numeric">{delivery.manualResends}</td><td>{delivery.lastError ? <span className="cell-truncate" title={delivery.lastError}>{delivery.lastError}</span> : '—'}</td><td>{delivery.remoteId ? <span className="cell-truncate mono" title={delivery.remoteId}>{delivery.remoteId}</span> : '—'}</td>
    <td className="col-actions"><div className="product-actions-row"><button className="button button--quiet" type="button" onClick={(event) => onInspect(delivery, event.currentTarget)}><Icon name="file-text" /> {t('payload')}</button><RowMenu disabled={!!entry} items={menuItems} /></div></td>
  </tr>;
}

function PayloadDrawer({ delivery, returnFocus, onClose, onTerminalError }: { delivery: Delivery; returnFocus: HTMLElement | null; onClose: () => void; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const payloadQuery = useQuery({ queryKey: erpDeliveryKeys.detail(delivery.orderId), queryFn: ({ signal }) => api.inspectDeliveryPayload(delivery.orderId, signal) });
  const command = useErpCommand();
  const entry = useAdminOperationEntries().filter(isErpOperationEntry).find((candidate) => candidate.operation.scope === erpScope(delivery.orderId));
  const retryRef = useRef<HTMLButtonElement>(null);
  const [copyError, setCopyError] = useState<unknown>(null);
  const [terminalError, setTerminalError] = useState<unknown>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  useEffect(() => { if (entry?.phase === 'unknown') retryRef.current?.focus(); }, [entry?.attempt, entry?.phase]);
  const resend = async (recovery?: AdminOperationEntry<ErpOperation>) => {
    const operation: ErpOperation = recovery?.operation ?? { area: 'erp-delivery', scope: erpScope(delivery.orderId), kind: 'resend', orderId: delivery.orderId, idempotencyKey: crypto.randomUUID() };
    const result = await command(operation, recovery);
    if (result.state === 'rejected') { setTerminalError(result.error); onTerminalError(result.error); }
  };
  const copy = async () => {
    if (!payloadQuery.data) return;
    try { await navigator.clipboard.writeText(JSON.stringify(payloadQuery.data.payload, null, 2)); setCopyState('copied'); }
    catch (error) { setCopyError(error); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="payload-drawer" aria-describedby="payload-drawer-notice" onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus?.focus(); }}>
    <header><div><DialogTitle>{t('payloadDialog')}</DialogTitle><DialogDescription>{delivery.orderNumber} · {delivery.reference}</DialogDescription></div><DialogClose className="icon-button" type="button" aria-label={t('closePayload')}><Icon name="close" /></DialogClose></header>
    <p id="payload-drawer-notice" className="payload-drawer__notice">{t('payloadNotice')}</p>
    {copyError ? <ErrorBanner error={copyError} onDismiss={() => setCopyError(null)} /> : null}
    {terminalError ? <ErrorBanner error={terminalError} onDismiss={() => setTerminalError(null)} /> : null}
    {payloadQuery.isError ? <ErrorBanner error={payloadQuery.error} onRetry={() => void payloadQuery.refetch()} /> : null}
    {entry ? <div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('operationPending') : t('unknownError')}</strong>{entry.phase === 'unknown' ? <button ref={retryRef} className="button button--quiet" type="button" onClick={() => void resend(entry)}>{t('retryOriginalOperation')}</button> : null}</div> : null}
    {payloadQuery.isLoading ? <Loading /> : payloadQuery.isSuccess ? <pre>{JSON.stringify(payloadQuery.data.payload, null, 2)}</pre> : null}
    <footer><button className="button button--quiet" type="button" disabled={!payloadQuery.data} onClick={() => void copy()}>{copyState === 'copied' ? t('copied') : t('copyJson')}</button><button className="button button--primary" type="button" disabled={!!entry} onClick={() => void resend()}>{entry?.phase === 'pending' ? t('resending') : t('resendToErp')}</button></footer>
  </DialogContent></Dialog>;
}

function ErpRecovery({ entry, onTerminalError }: { entry: AdminOperationEntry<ErpOperation>; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const command = useErpCommand();
  const [submitting, setSubmitting] = useState(false);
  const retry = async () => { setSubmitting(true); const result = await command(entry.operation, entry); if (result.state === 'rejected') onTerminalError(result.error); setSubmitting(false); };
  return <section className="account-panel" aria-label={t('resendToErp')}><div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('operationPending') : t('unknownError')}</strong>{entry.phase === 'unknown' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}</div><dl className="order-totals"><dt>{t('orderId')}</dt><dd className="mono">{entry.operation.orderId}</dd></dl></section>;
}
