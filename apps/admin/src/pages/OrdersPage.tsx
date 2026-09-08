import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Order, type Rma } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ReasonDialog } from '../components/ReasonDialog';
import { orderKeys, refundKeys, rmaKeys } from '../query';
import { isRmaReasonOperation, rmaScope, type RmaOperation, type RmaOperationResource, useRmaCommand } from '../rma-operations';
import { type AdminOperationEntry, useAdminOperationEntries } from '../admin-operations';
import { isRmaOperationEntry } from '../rma-operations';
import { isOrderOperationEntry, orderScope, refundScope, type OrderOperation, useOrderCommand } from '../order-operations';

const ORDER_STATUS_OPTIONS = {
  pending: 'pending',
  payment_processing: 'payment_processing',
  awaiting_payment: 'awaiting_payment',
  paid: 'paid',
  cancelled: 'cancelled',
  expired: 'expired',
} satisfies Record<Order['status'], Order['status']>;
const orderStatusOptions = Object.values(ORDER_STATUS_OPTIONS);

export function OrdersPage() {
  const { t, formatMoney } = useI18n();
  const [status, setStatus] = useState<Order['status'] | ''>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reasonTarget, setReasonTarget] = useState<{ rma: Rma; action: 'information' | 'reject'; returnFocus: HTMLElement | null } | null>(null);
  const [recoveryReason, setRecoveryReason] = useState<AdminOperationEntry<RmaOperation> | null>(null);
  const operationPendingRef = useRef(false);
  const recoveryRetryRef = useRef<HTMLButtonElement>(null);
  const [operationPending, setOperationPending] = useState(false);
  const runRmaCommand = useRmaCommand();
  const operationEntries = useAdminOperationEntries();
  const rmaRecoveries = operationEntries.filter(isRmaOperationEntry);
  const orderRecoveries = operationEntries.filter(isOrderOperationEntry);
  const runOrderCommand = useOrderCommand();

  const orderInput = { status: status || undefined, limit: 50, offset: 0 };
  const queueInput = { limit: 50, offset: 0 };
  const ordersQuery = useQuery({ queryKey: orderKeys.list(orderInput), queryFn: ({ signal }) => api.listOrders(orderInput, signal) });
  const refundsQuery = useQuery({ queryKey: refundKeys.list(queueInput), queryFn: ({ signal }) => api.listRefunds(queueInput, signal) });
  const rmasQuery = useQuery({ queryKey: rmaKeys.list(queueInput), queryFn: ({ signal }) => api.listRmas(queueInput, signal) });
  const orders = ordersQuery.isSuccess ? ordersQuery.data.items : [];
  const refundQueue = refundsQuery.isSuccess ? refundsQuery.data.items : [];
  const rmaQueue = rmasQuery.isSuccess ? rmasQuery.data.items : [];
  const retryQueuedRefund = async (refundId: string) => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setOperationPending(true);
    setError(null);
    try {
      const recovery = orderRecoveries.find((entry) => entry.operation.scope === refundScope(refundId));
      const result = await runOrderCommand({ area: 'order', scope: refundScope(refundId), kind: 'retry-refund', refundId, request: {}, draft: {}, idempotencyKey: crypto.randomUUID() }, recovery?.operation.kind === 'retry-refund' ? recovery : undefined);
      if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    } catch (err) { setError(err); }
    finally { operationPendingRef.current = false; setOperationPending(false); }
  };
  const runRmaAction = async (rma: Rma, action: 'approve' | 'receive' | 'refund' | 'retry') => {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setOperationPending(true);
    setError(null);
    try {
      const operation: RmaOperation | null = action === 'approve'
        ? { area: 'rma', scope: rmaScope(rma.id), kind: 'approve', rmaId: rma.id, resource: rmaResource(rma), request: {}, draft: { note: '' }, idempotencyKey: crypto.randomUUID() }
        : action === 'receive'
          ? { area: 'rma', scope: rmaScope(rma.id), kind: 'receive', rmaId: rma.id, resource: rmaResource(rma), request: { lines: rma.lines.map((line) => ({ rmaLineId: line.id, disposition: 'restock' })) }, draft: { lines: rma.lines.map((line) => ({ rmaLineId: line.id, disposition: 'restock', discardReason: '' })) }, idempotencyKey: crypto.randomUUID() }
          : action === 'refund'
            ? { area: 'rma', scope: rmaScope(rma.id), kind: 'refund', rmaId: rma.id, resource: rmaResource(rma), request: {}, draft: { reason: '' }, idempotencyKey: crypto.randomUUID() }
            : rma.refundId ? { area: 'rma', scope: rmaScope(rma.id), kind: 'retry-refund', rmaId: rma.id, resource: rmaResource(rma), request: { refundId: rma.refundId }, draft: {}, idempotencyKey: crypto.randomUUID() } : null;
      if (!operation) return;
      const result = await runRmaCommand(operation);
      if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    } catch (err) { setError(err); }
    finally { operationPendingRef.current = false; setOperationPending(false); }
  };
  const retryRma = async (entry: AdminOperationEntry<RmaOperation>) => {
    setOperationPending(true); setError(null);
    const result = await runRmaCommand(entry.operation, entry);
    if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    setOperationPending(false);
  };

  // 補件與拒絕都要留下理由，理由收在頁內對話框而不是 window.prompt。
  const submitRmaReason = async (reason: string) => {
    if (!reasonTarget) return;
    const { rma, action } = reasonTarget;
    setError(null);
    try {
      const result = await runRmaCommand({ area: 'rma', scope: rmaScope(rma.id), kind: action, rmaId: rma.id, resource: rmaResource(rma), request: { reason }, draft: { reason }, idempotencyKey: crypto.randomUUID() });
      if (result.state === 'success') setReasonTarget(null);
      else if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    } catch (err) { setError(err); }
  };
  const submitRecoveryReason = async (reason: string) => {
    if (!recoveryReason || !isRmaReasonOperation(recoveryReason.operation)) return;
    setError(null);
    const operation = recoveryReason.operation;
    const result = await runRmaCommand({ ...operation, request: { reason }, draft: { reason }, idempotencyKey: crypto.randomUUID() });
    if (result.state === 'success') setRecoveryReason(null);
    else if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
  };
  const paid = orders.filter((order) => order.status === 'paid');
  const pending = orders.filter((order) => order.status === 'pending' || order.status === 'payment_processing' || order.status === 'awaiting_payment');
  const gmv = paid.reduce((total, order) => total + order.totalCents, 0);
  const activeReasonRecovery = reasonTarget ? rmaRecoveries.find((entry) => entry.operation.rmaId === reasonTarget.rma.id && isRmaReasonOperation(entry.operation) && entry.operation.kind === reasonTarget.action) ?? null : null;

  return (
    <section>
      {ordersQuery.isError ? <ErrorBanner error={ordersQuery.error} onRetry={() => void ordersQuery.refetch()} /> : null}
      {refundsQuery.isError ? <ErrorBanner error={refundsQuery.error} onRetry={() => void refundsQuery.refetch()} /> : null}
      {rmasQuery.isError ? <ErrorBanner error={rmasQuery.error} onRetry={() => void rmasQuery.refetch()} /> : null}

      {ordersQuery.isLoading ? <Loading /> : ordersQuery.isSuccess ? <><div className="pipeline" aria-label={t('erpPipeline')}>
        <span>{t('ingest')}</span><b>{orders.length}</b><i><Icon name="arrow-right" /></i><span>{t('queue')}</span><b>{pending.length}</b><i><Icon name="arrow-right" /></i><span>{t('worker')}</span><b>{t('pipelineActive')}</b><i><Icon name="arrow-right" /></i><span>DLQ</span><b className="pipeline__alert">{orders.filter((order) => order.status === 'cancelled').length}</b>
      </div>
      <div className="summary-cards summary-cards--orders">
        <Metric label={t('transactionTotal')} value={formatMoney(gmv, orders[0]?.currency ?? 'TWD')} /><Metric label={t('pendingOrders')} value={String(pending.length)} /><Metric label={t('completedOrders')} value={String(paid.length)} /><Metric label={t('currentlyShown')} value={String(orders.length)} />
      </div></> : null}

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(orderStatusOptions.find((option) => option === e.target.value) ?? '')}>
          <option value="">{t('allStatuses')}</option>{orderStatusOptions.map((value) => <option key={value} value={value}>{t(value)}</option>)}
        </select>
      </div>

      <section className="account-panel" aria-label={t('refundQueue')}>
        <div className="section-heading"><h2>{t('refundQueue')}</h2><p>{t('refundQueueHint')}</p></div>
        {refundsQuery.isLoading ? <Loading /> : refundsQuery.isSuccess ? refundQueue.length === 0 ? <EmptyState icon="refresh" title={t('noRefunds')} hint={t('noRefundsHint')} /> : (
          <div className="table-wrap"><table className="data-table data-table--fixed orders-queue-table"><thead><tr><th style={{ width: '26%' }}>{t('orders')}</th><th style={{ width: '14%' }}>{t('status')}</th><th style={{ width: '14%' }} className="col-numeric">{t('amount')}</th><th style={{ width: '32%' }}>{t('failureReason')}</th><th style={{ width: '14%' }} className="col-actions">{t('actions')}</th></tr></thead>
            <tbody>{refundQueue.map((refund) => <tr key={refund.id}>
              <td><span className="cell-truncate mono" title={refund.orderId}>{refund.orderId}</span></td>
              <td><StatusBadge value={refund.status} /></td>
              <td className="col-numeric">{formatMoney(refund.amountCents, refund.currency)}</td>
              <td><span className="cell-truncate" title={refund.failureMessage ?? undefined}>{refund.failureMessage ?? '—'}</span></td>
              <td className="col-actions">{refund.status === 'failed' ? <button className="button button--quiet" type="button" disabled={operationPending || orderRecoveries.some((entry) => entry.operation.scope === refundScope(refund.id))} onClick={() => void retryQueuedRefund(refund.id)}><Icon name="refresh" /> {t('retryRefund')}</button> : <span className="text-muted">—</span>}</td>
            </tr>)}</tbody>
          </table></div>
        ) : null}
      </section>

      <section className="account-panel" aria-label={t('returnQueue')}>
        <div className="section-heading"><h2>{t('returnQueue')}</h2><p>{t('returnQueueHint')}</p></div>
        {rmasQuery.isLoading ? <Loading /> : rmasQuery.isSuccess ? rmaQueue.length === 0 ? <EmptyState icon="box" title={t('noRmas')} hint={t('noRmasHint')} /> : (
          <div className="table-wrap"><table className="data-table data-table--fixed orders-queue-table"><thead><tr><th style={{ width: '22%' }}>{t('orders')}</th><th style={{ width: '24%' }}>{t('item')}</th><th style={{ width: '14%' }}>{t('status')}</th><th style={{ width: '18%' }}>{t('reason')}</th><th style={{ width: '22%' }} className="col-actions">{t('actions')}</th></tr></thead>
            <tbody>{rmaQueue.map((rma) => <tr key={rma.id}>
              <td><span className="cell-truncate mono" title={rma.orderId}>{rma.orderId}</span></td>
              <td><span className="cell-truncate" title={rma.lines.map((line) => `${line.name} × ${line.quantity}`).join('、')}>{rma.lines.map((line) => `${line.name} × ${line.quantity}`).join('、')}</span></td>
              <td><StatusBadge value={rma.status} /></td>
              <td><span className="cell-truncate" title={rma.staffNote ?? rma.reason}>{rma.staffNote ?? rma.reason}</span></td>
              <td className="col-actions">
                <RmaActions rma={rma} busy={operationPending || rmaRecoveries.some((entry) => entry.operation.scope === rmaScope(rma.id))} onRun={runRmaAction} onAskReason={(action, returnFocus) => setReasonTarget({ rma, action, returnFocus })} />
              </td>
            </tr>)}</tbody>
          </table></div>
        ) : null}
      </section>
      {rmaRecoveries.map((entry) => <section className="account-panel" key={entry.operation.idempotencyKey} aria-label={`${t('returnQueue')} ${entry.operation.rmaId}`}><div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('productOperationPending') : t('unknownError')}</strong><span>{entry.operation.rmaId}</span>{entry.phase === 'unknown' ? <button className="button button--quiet" type="button" disabled={operationPending} onClick={() => void retryRma(entry)}>{t('retryOriginalOperation')}</button> : null}{isRmaReasonOperation(entry.operation) ? <button className="button button--quiet" type="button" onClick={() => setRecoveryReason(entry)}>{t('inspectOriginalOperation')}</button> : null}</div><RmaRecoveryPreview operation={entry.operation} /></section>)}
      <OrderRecoveries entries={orderRecoveries} />

      {reasonTarget ? (
        <ReasonDialog
          title={reasonTarget.action === 'information' ? t('requestInformation') : t('rejectReturn')}
          description={reasonTarget.action === 'information'
            ? t('rmaInformationDescription')
            : t('rmaRejectionDescription')}
          confirmLabel={reasonTarget.action === 'information' ? t('submitCorrection') : t('rejectAction')}
          placeholder={reasonTarget.action === 'information' ? t('rmaInformationPlaceholder') : t('rmaRejectionPlaceholder')}
          danger={reasonTarget.action === 'reject'}
          error={error}
          onDismissError={() => setError(null)}
          initialReason={activeReasonRecovery && isRmaReasonOperation(activeReasonRecovery.operation) ? activeReasonRecovery.operation.draft.reason : undefined}
          readOnly={Boolean(activeReasonRecovery)}
          recoveryFocusRef={recoveryRetryRef}
          recoveryReady={activeReasonRecovery?.phase === 'unknown' && !operationPending}
          recoveryAction={activeReasonRecovery?.phase === 'unknown' ? <button ref={recoveryRetryRef} className="button button--primary" type="button" disabled={operationPending} onClick={() => void retryRma(activeReasonRecovery)}>{t('retryOriginalOperation')}</button> : null}
          labels={{ close: t('close'), cancel: t('cancel'), invalidReason: t('invalidReason'), submitting: t('submitting') }}
          returnFocus={reasonTarget.returnFocus}
          onClose={() => setReasonTarget(null)}
          onConfirm={submitRmaReason}
        />
      ) : null}
      {recoveryReason && isRmaReasonOperation(recoveryReason.operation) ? (() => {
        const liveRecovery = rmaRecoveries.find((entry) => entry.operation.idempotencyKey === recoveryReason.operation.idempotencyKey) ?? null;
        return <ReasonDialog title={recoveryReason.operation.kind === 'information' ? t('requestInformation') : t('rejectReturn')} confirmLabel={recoveryReason.operation.kind === 'information' ? t('submitCorrection') : t('rejectAction')} danger={recoveryReason.operation.kind === 'reject'} initialReason={recoveryReason.operation.draft.reason} readOnly={Boolean(liveRecovery)} error={error} onDismissError={() => setError(null)} recoveryFocusRef={recoveryRetryRef} recoveryReady={liveRecovery?.phase === 'unknown' && !operationPending} recoveryAction={liveRecovery?.phase === 'unknown' ? <button ref={recoveryRetryRef} className="button button--primary" type="button" disabled={operationPending} onClick={() => void retryRma(liveRecovery)}>{t('retryOriginalOperation')}</button> : null} labels={{ close: t('close'), cancel: t('cancel'), invalidReason: t('invalidReason'), submitting: t('submitting') }} onClose={() => setRecoveryReason(null)} onConfirm={submitRecoveryReason} />;
      })() : null}

      {ordersQuery.isSuccess ? (
        <div className="table-wrap"><table className="data-table data-table--fixed orders-table">
          <thead>
            <tr>
              <th style={{ width: '14%' }}>{t('orderNumber')}</th>
              <th style={{ width: '28%' }}>{t('customer')}</th>
              <th style={{ width: '14%' }}>{t('status')}</th>
              <th style={{ width: '14%' }} className="col-numeric">{t('total')}</th>
              <th style={{ width: '20%' }}>{t('orderedAt')}</th>
              <th style={{ width: '10%' }} className="col-actions">{t('orderDetail')}</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState icon="receipt" title={t('noOrders')} hint={t('noOrdersHint')} />
                </td>
              </tr>
            ) : orders.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                expanded={expandedId === order.id}
                onToggle={() => setExpandedId(expandedId === order.id ? null : order.id)}
              />
            ))}
          </tbody>
        </table></div>
      ) : null}
    </section>
  );
}

function OrderRecoveries({ entries }: { entries: AdminOperationEntry<OrderOperation>[] }) {
  const { t } = useI18n();
  const command = useOrderCommand();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!entries.length) return error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null;
  return <div className="command-recoveries" aria-live="polite">{entries.map((entry) => {
    const operation = entry.operation;
    const action = operation.kind === 'pay' ? t('requestPayment') : operation.kind === 'cancel' ? t('cancelOrder') : operation.kind === 'refund' ? t('requestFullRefund') : t('retryRefund');
    const resource = operation.kind === 'retry-refund' ? operation.refundId : operation.orderId;
    const detail = operation.kind === 'cancel' || operation.kind === 'refund' ? operation.draft.reason : null;
    return <section className="account-panel" key={operation.idempotencyKey} aria-label={`${action} ${resource}`}>
      <div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('running') : t('unknownError')}</strong><span>{action} · {resource}</span>{entry.phase === 'unknown' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => { setSubmitting(true); void command(operation, entry).then((result) => { if (result.state === 'rejected') setError(result.error); }).finally(() => setSubmitting(false)); }}>{t('retryOriginalOperation')}</button> : null}</div>
      {detail ? <dl className="order-totals"><dt>{t('reason')}</dt><dd>{detail}</dd></dl> : null}
    </section>;
  })}</div>;
}

function rmaResource(rma: Rma): RmaOperationResource {
  return { orderId: rma.orderId, lines: rma.lines.map((line) => ({ rmaLineId: line.id, sku: line.sku, name: line.name, quantity: line.quantity })) };
}

function RmaRecoveryPreview({ operation }: { operation: RmaOperation }) {
  const { t } = useI18n();
  const action = operation.kind === 'approve' ? t('approveReturn') : operation.kind === 'information' ? t('requestInformation') : operation.kind === 'reject' ? t('rejectReturn') : operation.kind === 'receive' ? t('receiveReturn') : operation.kind === 'refund' ? t('requestRefund') : t('retryRefund');
  return <dl className="order-totals"><dt>{t('rmaCase')}</dt><dd className="mono">{operation.rmaId}</dd><dt>{t('orderId')}</dt><dd className="mono">{operation.resource.orderId}</dd><dt>{t('actions')}</dt><dd>{action}</dd>{operation.resource.lines.map((line) => <Fragment key={line.rmaLineId}><dt>{t('products')}</dt><dd>{line.name} · {line.sku} × {line.quantity}</dd></Fragment>)}{operation.kind === 'approve' ? <><dt>{t('staffNote')}</dt><dd>{operation.draft.note || '—'}</dd></> : null}{operation.kind === 'information' || operation.kind === 'reject' || operation.kind === 'refund' ? <><dt>{t('returnReason')}</dt><dd>{operation.draft.reason || '—'}</dd></> : null}{operation.kind === 'receive' ? operation.draft.lines.map((line) => <Fragment key={line.rmaLineId}><dt>{t('disposition')} · <code>{line.rmaLineId}</code></dt><dd>{line.disposition === 'restock' ? t('restock') : `${t('discard')} · ${line.discardReason || '—'}`}</dd></Fragment>) : null}</dl>;
}

/**
 * 退貨案件的動作：狀態決定「現在最該做的那一件」留在列上，
 * 其餘（含破壞性的拒絕）收進 ⋯ 選單，避免一列擠三顆按鈕。
 */
function RmaActions({
  rma,
  busy,
  onRun,
  onAskReason,
}: {
  rma: Rma;
  busy: boolean;
  onRun: (rma: Rma, action: 'approve' | 'receive' | 'refund' | 'retry') => void;
  onAskReason: (action: 'information' | 'reject', returnFocus: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const primary = rma.status === 'approved'
    ? { label: t('receiveAndRestock'), icon: 'box' as const, run: () => onRun(rma, 'receive') }
    : rma.status === 'received'
      ? { label: t('requestRefund'), icon: 'send' as const, run: () => onRun(rma, 'refund') }
      : rma.status === 'refund_failed'
        ? { label: t('retryRefund'), icon: 'refresh' as const, run: () => onRun(rma, 'retry') }
        : ['requested', 'needs_information'].includes(rma.status)
          ? { label: t('approveReturn'), icon: 'check' as const, run: () => onRun(rma, 'approve') }
          : null;

  const menuItems: RowMenuItem[] = [
    ...(['requested', 'approved'].includes(rma.status)
      ? [{ key: 'information', label: t('requestInformation'), icon: 'file-text' as const, onSelect: (returnFocus: HTMLButtonElement | null) => onAskReason('information', returnFocus) }]
      : []),
    ...(['requested', 'needs_information', 'approved'].includes(rma.status)
      ? [{ key: 'reject', label: t('rejectAction'), icon: 'ban' as const, danger: true, onSelect: (returnFocus: HTMLButtonElement | null) => onAskReason('reject', returnFocus) }]
      : []),
  ];

  if (!primary && menuItems.length === 0) return <span className="text-muted">—</span>;

  return (
    <div className="product-actions-row">
      {primary ? (
        <button className="button button--quiet" type="button" disabled={busy} onClick={primary.run}>
          <Icon name={primary.icon} /> {primary.label}
        </button>
      ) : null}
      {menuItems.length > 0 ? <RowMenu items={menuItems} label={t('moreActions')} disabled={busy} /> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="summary-card"><span className="summary-card__label">{label}</span><span className="summary-card__value">{value}</span></div>;
}

function OrderRow({
  order,
  expanded,
  onToggle,
}: {
  order: Order;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, formatMoney, formatDateTime } = useI18n();
  const runOrderCommand = useOrderCommand();
  const operationEntries = useAdminOperationEntries();
  const orderRecoveries = operationEntries.filter(isOrderOperationEntry);
  const orderOccupancy = operationEntries.find((entry) => entry.operation.scope === orderScope(order.id)) ?? null;
  const orderRecovery = orderOccupancy && isOrderOperationEntry(orderOccupancy) ? orderOccupancy : null;
  const [reason, setReason] = useState(() => orderRecovery?.operation.kind === 'cancel' ? orderRecovery.operation.draft.reason : '');
  const [refundReason, setRefundReason] = useState(() => orderRecovery?.operation.kind === 'refund' ? orderRecovery.operation.draft.reason : '');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [refundSubmissionKey, setRefundSubmissionKey] = useState(() => crypto.randomUUID());
  const [refundAttempt, setRefundAttempt] = useState<{ reason: string; rawReason: string; key: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refundRecovery = orderRecovery?.operation.kind === 'refund' ? orderRecovery : null;
  const hadRefundRecovery = useRef(Boolean(refundRecovery));
  const refundsQuery = useQuery({ queryKey: refundKeys.list({ orderId: order.id, limit: 20, offset: 0 }), queryFn: ({ signal }) => api.listRefunds({ orderId: order.id, limit: 20, offset: 0 }, signal), enabled: expanded });
  const refunds = refundsQuery.isSuccess ? refundsQuery.data.items : [];

  useEffect(() => {
    if (hadRefundRecovery.current && !refundRecovery && refundAttempt) {
      setRefundAttempt(null);
      setRefundReason(refundAttempt.rawReason);
      setRefundSubmissionKey(crypto.randomUUID());
    }
    hadRefundRecovery.current = Boolean(refundRecovery);
  }, [refundAttempt, refundRecovery]);

  const handlePay = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await runOrderCommand({ area: 'order', scope: orderScope(order.id), kind: 'pay', orderId: order.id, request: {}, draft: {}, idempotencyKey: crypto.randomUUID() }, orderRecovery?.operation.kind === 'pay' ? orderRecovery : undefined);
      if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    } catch (err) {
      setError(err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (submittingRef.current) return;
    if (!reason.trim()) {
      setError(new Error(t('invalidCancelReason')));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const request = { reason: reason.trim() };
      const result = await runOrderCommand({ area: 'order', scope: orderScope(order.id), kind: 'cancel', orderId: order.id, request, draft: { reason }, idempotencyKey: crypto.randomUUID() }, orderRecovery?.operation.kind === 'cancel' ? orderRecovery : undefined);
      if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    } catch (err) {
      setError(err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleRefund = async () => {
    if (submittingRef.current) return;
    const attempt = refundAttempt ?? { reason: refundReason.trim(), rawReason: refundReason, key: refundSubmissionKey };
    if (!attempt.reason) { setError(new Error(t('invalidRefundReason'))); return; }
    if (!refundAttempt) setRefundAttempt(attempt);
    submittingRef.current = true; setSubmitting(true); setError(null);
    try {
      const result = await runOrderCommand({ area: 'order', scope: orderScope(order.id), kind: 'refund', orderId: order.id, request: { reason: attempt.reason }, draft: { reason: attempt.rawReason }, idempotencyKey: attempt.key }, orderRecovery?.operation.kind === 'refund' ? orderRecovery : undefined);
      if (result.state === 'success') { setRefundAttempt(null); setRefundReason(''); setRefundSubmissionKey(crypto.randomUUID()); }
      else if (result.state === 'rejected') { setRefundAttempt(null); setRefundReason(attempt.rawReason); setRefundSubmissionKey(crypto.randomUUID()); setError(result.error); }
      else if (result.state === 'unknown') setError(result.error);
    }
    finally { submittingRef.current = false; setSubmitting(false); }
  };

  const handleRetryRefund = async (refundId: string) => {
    if (submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true); setError(null);
    try { const recovery = orderRecoveries.find((entry) => entry.operation.scope === refundScope(refundId)); const result = await runOrderCommand({ area: 'order', scope: refundScope(refundId), kind: 'retry-refund', refundId, request: {}, draft: {}, idempotencyKey: crypto.randomUUID() }, recovery?.operation.kind === 'retry-refund' ? recovery : undefined); if (result.state === 'rejected' || result.state === 'unknown') setError(result.error); }
    finally { submittingRef.current = false; setSubmitting(false); }
  };

  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td className="mono">{order.number}</td>
        <td><span className="cell-truncate" title={order.customerEmail}>{order.customerEmail}</span></td>
        <td><StatusBadge value={order.status} /></td>
        <td className="col-numeric">{formatMoney(order.totalCents, order.currency)}</td>
        <td className="mono">{formatDateTime(order.placedAt)}</td>
        <td className="col-actions">
          <button
            type="button"
            className="button button--quiet"
            aria-expanded={expanded}
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
          >
            {expanded ? t('collapse') : t('view')}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <div className="order-detail">
              {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
              <table className="data-table data-table--nested">
                <thead>
                  <tr>
                    <th style={{ width: '14%' }}>SKU</th>
                    <th style={{ width: '28%' }}>{t('name')}</th>
                    <th style={{ width: '12%' }} className="col-numeric">{t('unitPrice')}</th>
                    <th style={{ width: '8%' }} className="col-numeric">{t('quantity')}</th>
                    <th style={{ width: '12%' }} className="col-numeric">{t('subtotal')}</th>
                    <th style={{ width: '13%' }} className="col-numeric">{t('discount')}</th>
                    <th style={{ width: '13%' }} className="col-numeric">{t('netAmount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="mono">{line.sku}</td>
                      <td><span className="cell-truncate" title={line.name}>{line.name}</span></td>
                      <td className="col-numeric">{formatMoney(line.unitPriceCents, order.currency)}</td>
                      <td className="col-numeric">{line.quantity}</td>
                      <td className="col-numeric">{formatMoney(line.lineTotalCents, order.currency)}</td>
                      <td className="col-numeric">{line.discountCents > 0 ? `-${formatMoney(line.discountCents, order.currency)}` : '—'}</td>
                      <td className="col-numeric">{formatMoney(line.lineTotalCents - line.discountCents, order.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <dl className="order-totals">
                <dt>{t('subtotal')}</dt>
                <dd className="mono">{formatMoney(order.subtotalCents, order.currency)}</dd>
                {order.adjustments.map((adjustment) => (
                  <div key={`${adjustment.sourceId}-${adjustment.name}`}>
                    <dt>{adjustment.name}</dt>
                    <dd className="mono">{formatMoney(adjustment.amountCents, order.currency)}</dd>
                  </div>
                ))}
                <dt>{t('total')}</dt>
                <dd className="mono">{formatMoney(order.totalCents, order.currency)}</dd>
              </dl>

              {order.status === 'pending' && (
                <div className="inline-form">
                  <button id="order-actions" className="button button--primary" type="button" disabled={submitting || !!orderOccupancy} onClick={handlePay}>
                    {t('requestPayment')}
                  </button>
                  <input placeholder={t('cancellationReason')} value={reason} readOnly={!!orderOccupancy} onChange={(e) => setReason(e.target.value)} />
                  <button className="button" type="button" disabled={submitting || !!orderOccupancy} onClick={handleCancel}>
                    {t('cancelOrder')}
                  </button>
                </div>
              )}
              {order.status === 'paid' && (
                <div className="inline-form" aria-label={t('refundOperation')}>
                  <input placeholder={t('refundReason')} value={refundAttempt?.rawReason ?? refundReason} disabled={Boolean(refundAttempt)} readOnly={!!orderOccupancy} onChange={(e) => setRefundReason(e.target.value)} />
                  <button id="refund-actions" className="button button--primary" type="button" disabled={submitting || !!orderOccupancy || !refundsQuery.isSuccess || refundsQuery.isFetching || refunds.some((refund) => refund.status !== 'failed')} onClick={handleRefund}>
                    {t('requestFullRefund')}
                  </button>
                </div>
              )}
              {refundsQuery.isLoading ? <Loading /> : null}
              {refundsQuery.isSuccess && refunds.length > 0 && (
                <table className="data-table data-table--nested" aria-label={t('refundQueue')}>
                  <thead><tr><th style={{ width: '18%' }}>{t('refundStatus')}</th><th style={{ width: '16%' }} className="col-numeric">{t('amount')}</th><th style={{ width: '48%' }}>{t('reasonAndFailure')}</th><th style={{ width: '18%' }} className="col-actions">{t('actions')}</th></tr></thead>
                  <tbody>{refunds.map((refund) => (
                    <tr key={refund.id}>
                      <td><StatusBadge value={refund.status} /></td>
                      <td className="col-numeric">{formatMoney(refund.amountCents, refund.currency)}</td>
                      <td><span className="cell-truncate" title={refund.failureMessage ?? refund.reason}>{refund.failureMessage ?? refund.reason}</span></td>
                      <td className="col-actions">{refund.status === 'failed' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => handleRetryRefund(refund.id)}><Icon name="refresh" /> {t('retryRefund')}</button> : <span className="text-muted">—</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {refundsQuery.isError ? <ErrorBanner error={refundsQuery.error} onRetry={() => void refundsQuery.refetch()} /> : null}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
