import { useEffect, useState } from 'react';
import { api, type Order, type Refund, type Rma } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ReasonDialog } from '../components/ReasonDialog';

export function OrdersPage() {
  const { t, formatMoney } = useI18n();
  const [status, setStatus] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [refundQueue, setRefundQueue] = useState<Refund[]>([]);
  const [rmaQueue, setRmaQueue] = useState<Rma[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{ rma: Rma; action: 'information' | 'reject' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api.listOrders({ status: status || undefined, limit: 50 }),
      api.listRefunds({ limit: 50 }),
      api.listRmas({ limit: 50 }),
    ])
      .then(([ordersResult, refundsResult, rmasResult]) => {
        if (!cancelled) { setOrders(ordersResult.items); setRefundQueue(refundsResult.items); setRmaQueue(rmasResult.items); }
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [status, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const retryQueuedRefund = async (refundId: string) => {
    setError(null);
    try { await api.retryRefund(refundId); reload(); }
    catch (err) { setError(err); }
  };
  const runRmaAction = async (rma: Rma, action: 'approve' | 'receive' | 'refund' | 'retry') => {
    setError(null);
    try {
      if (action === 'approve') await api.approveRma(rma.id);
      if (action === 'receive') await api.receiveRma(rma.id, rma.lines.map((line) => ({ rmaLineId: line.id, disposition: 'restock' })));
      if (action === 'refund') await api.requestRmaRefund(rma.id);
      if (action === 'retry' && rma.refundId) await api.retryRefund(rma.refundId);
      reload();
    } catch (err) { setError(err); }
  };

  // 補件與拒絕都要留下理由，理由收在頁內對話框而不是 window.prompt。
  const submitRmaReason = async (reason: string) => {
    if (!reasonTarget) return;
    const { rma, action } = reasonTarget;
    setError(null);
    try {
      if (action === 'information') await api.requestRmaInformation(rma.id, reason);
      else await api.rejectRma(rma.id, reason);
      setReasonTarget(null);
      reload();
    } catch (err) { setError(err); }
  };
  const paid = orders.filter((order) => order.status === 'paid');
  const pending = orders.filter((order) => order.status === 'pending' || order.status === 'payment_processing');
  const gmv = paid.reduce((total, order) => total + order.totalCents, 0);

  return (
    <section>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      <div className="pipeline" aria-label={t('erpPipeline')}>
        <span>Ingest</span><b>{orders.length}</b><i><Icon name="arrow-right" /></i><span>Queue</span><b>{pending.length}</b><i><Icon name="arrow-right" /></i><span>Worker</span><b>Active</b><i><Icon name="arrow-right" /></i><span>DLQ</span><b className="pipeline__alert">{orders.filter((order) => order.status === 'cancelled').length}</b>
      </div>
      <div className="summary-cards summary-cards--orders">
        <Metric label={t('transactionTotal')} value={formatMoney(gmv, orders[0]?.currency ?? 'TWD')} /><Metric label={t('pendingOrders')} value={String(pending.length)} /><Metric label={t('completedOrders')} value={String(paid.length)} /><Metric label={t('currentlyShown')} value={String(orders.length)} />
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('allStatuses')}</option><option value="pending">{t('pending')}</option><option value="payment_processing">{t('payment_processing')}</option><option value="paid">{t('paid')}</option><option value="cancelled">{t('cancelled')}</option><option value="expired">{t('expired')}</option>
        </select>
      </div>

      <section className="account-panel" aria-label="退款作業隊列">
        <div className="section-heading"><h2>退款作業隊列</h2><p>待處理與失敗的退款可在此追蹤；失敗項目可安全重試。</p></div>
        {refundQueue.length === 0 ? <p className="muted">目前沒有退款紀錄。</p> : (
          <div className="table-wrap"><table className="data-table data-table--fixed"><thead><tr><th style={{ width: '26%' }}>訂單</th><th style={{ width: '14%' }}>狀態</th><th style={{ width: '14%' }} className="col-numeric">金額</th><th style={{ width: '32%' }}>失敗原因</th><th style={{ width: '14%' }} className="col-actions">操作</th></tr></thead>
            <tbody>{refundQueue.map((refund) => <tr key={refund.id}>
              <td><span className="cell-truncate mono" title={refund.orderId}>{refund.orderId}</span></td>
              <td><StatusBadge value={refund.status} /></td>
              <td className="col-numeric">{formatMoney(refund.amountCents, refund.currency)}</td>
              <td><span className="cell-truncate" title={refund.failureMessage ?? undefined}>{refund.failureMessage ?? '—'}</span></td>
              <td className="col-actions">{refund.status === 'failed' ? <button className="button button--quiet" type="button" onClick={() => void retryQueuedRefund(refund.id)}><Icon name="refresh" /> 重試退款</button> : <span className="text-muted">—</span>}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>

      <section className="account-panel" aria-label="退貨作業隊列">
        <div className="section-heading"><h2>退貨作業隊列</h2><p>換貨第一版採退款後重新下單；收件入庫只適用可回補的商品。</p></div>
        {rmaQueue.length === 0 ? <p className="muted">目前沒有退貨案件。</p> : (
          <div className="table-wrap"><table className="data-table data-table--fixed"><thead><tr><th style={{ width: '22%' }}>訂單</th><th style={{ width: '24%' }}>品項</th><th style={{ width: '14%' }}>狀態</th><th style={{ width: '18%' }}>原因</th><th style={{ width: '22%' }} className="col-actions">操作</th></tr></thead>
            <tbody>{rmaQueue.map((rma) => <tr key={rma.id}>
              <td><span className="cell-truncate mono" title={rma.orderId}>{rma.orderId}</span></td>
              <td><span className="cell-truncate" title={rma.lines.map((line) => `${line.name} × ${line.quantity}`).join('、')}>{rma.lines.map((line) => `${line.name} × ${line.quantity}`).join('、')}</span></td>
              <td><StatusBadge value={rma.status} /></td>
              <td><span className="cell-truncate" title={rma.staffNote ?? rma.reason}>{rma.staffNote ?? rma.reason}</span></td>
              <td className="col-actions">
                <RmaActions rma={rma} onRun={runRmaAction} onAskReason={(action) => setReasonTarget({ rma, action })} />
              </td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>

      {reasonTarget ? (
        <ReasonDialog
          title={reasonTarget.action === 'information' ? '要求補件' : '拒絕退貨'}
          description={reasonTarget.action === 'information'
            ? '說明還需要顧客補充哪些資料，內容會寫進案件紀錄。'
            : '拒絕會結束這件退貨，原因會寫進案件紀錄，顧客看得到。'}
          confirmLabel={reasonTarget.action === 'information' ? '送出' : '拒絕'}
          placeholder={reasonTarget.action === 'information' ? '例如：請補拍外包裝與商品瑕疵處照片' : '例如：不符合退貨條件'}
          danger={reasonTarget.action === 'reject'}
          onClose={() => setReasonTarget(null)}
          onConfirm={(reason) => void submitRmaReason(reason)}
        />
      ) : null}

      {loading ? (
        <Loading />
      ) : (
        <div className="table-wrap"><table className="data-table data-table--fixed">
          <thead>
            <tr>
              <th style={{ width: '14%' }}>{t('orderNumber')}</th>
              <th style={{ width: '28%' }}>{t('customer')}</th>
              <th style={{ width: '14%' }}>{t('status')}</th>
              <th style={{ width: '14%' }} className="col-numeric">{t('total')}</th>
              <th style={{ width: '20%' }}>{t('orderedAt')}</th>
              <th style={{ width: '10%' }} className="col-actions">{t('status') === 'Status' ? 'Detail' : '明細'}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                expanded={expandedId === order.id}
                onToggle={() => setExpandedId(expandedId === order.id ? null : order.id)}
                onChanged={reload}
              />
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

/**
 * 退貨案件的動作：狀態決定「現在最該做的那一件」留在列上，
 * 其餘（含破壞性的拒絕）收進 ⋯ 選單，避免一列擠三顆按鈕。
 */
function RmaActions({
  rma,
  onRun,
  onAskReason,
}: {
  rma: Rma;
  onRun: (rma: Rma, action: 'approve' | 'receive' | 'refund' | 'retry') => void;
  onAskReason: (action: 'information' | 'reject') => void;
}) {
  const primary = rma.status === 'approved'
    ? { label: '收件並全部回補', icon: 'box' as const, run: () => onRun(rma, 'receive') }
    : rma.status === 'received'
      ? { label: '申請退款', icon: 'send' as const, run: () => onRun(rma, 'refund') }
      : rma.status === 'refund_failed'
        ? { label: '重試退款', icon: 'refresh' as const, run: () => onRun(rma, 'retry') }
        : ['requested', 'needs_information'].includes(rma.status)
          ? { label: '核准', icon: 'check' as const, run: () => onRun(rma, 'approve') }
          : null;

  const menuItems: RowMenuItem[] = [
    ...(['requested', 'approved'].includes(rma.status)
      ? [{ key: 'information', label: '要求補件', icon: 'file-text' as const, onSelect: () => onAskReason('information') }]
      : []),
    ...(['requested', 'needs_information', 'approved'].includes(rma.status)
      ? [{ key: 'reject', label: '拒絕', icon: 'ban' as const, danger: true, onSelect: () => onAskReason('reject') }]
      : []),
  ];

  if (!primary && menuItems.length === 0) return <span className="text-muted">—</span>;

  return (
    <div className="product-actions-row">
      {primary ? (
        <button className="button button--quiet" type="button" onClick={primary.run}>
          <Icon name={primary.icon} /> {primary.label}
        </button>
      ) : null}
      {menuItems.length > 0 ? <RowMenu items={menuItems} /> : null}
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
  onChanged,
}: {
  order: Order;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { t, formatMoney, formatDateTime } = useI18n();
  const [reason, setReason] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handlePay = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.payOrder(order.id);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!reason.trim()) {
      setError(new Error(t('invalidCancelReason')));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.cancelOrder(order.id, reason.trim());
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api.listRefunds({ orderId: order.id, limit: 20 }).then((result) => {
      if (!cancelled) setRefunds(result.items);
    }).catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [expanded, order.id]);

  const handleRefund = async () => {
    if (!refundReason.trim()) { setError(new Error('請輸入退款原因')); return; }
    setSubmitting(true); setError(null);
    try { await api.requestRefund(order.id, refundReason.trim()); setRefundReason(''); onChanged(); const result = await api.listRefunds({ orderId: order.id }); setRefunds(result.items); }
    catch (err) { setError(err); }
    finally { setSubmitting(false); }
  };

  const handleRetryRefund = async (refundId: string) => {
    setSubmitting(true); setError(null);
    try { await api.retryRefund(refundId); const result = await api.listRefunds({ orderId: order.id }); setRefunds(result.items); onChanged(); }
    catch (err) { setError(err); }
    finally { setSubmitting(false); }
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

              {(order.status === 'pending' || order.status === 'payment_processing') && (
                <div className="inline-form">
                  <button id="order-actions" className="button button--primary" type="button" disabled={submitting} onClick={handlePay}>
                    {t('requestPayment')}
                  </button>
                  <input placeholder={t('cancellationReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button className="button" type="button" disabled={submitting} onClick={handleCancel}>
                    {t('cancelOrder')}
                  </button>
                </div>
              )}
              {order.status === 'paid' && (
                <div className="inline-form" aria-label="退款作業">
                  <input placeholder="退款原因" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
                  <button id="refund-actions" className="button button--primary" type="button" disabled={submitting || refunds.some((refund) => refund.status !== 'failed')} onClick={handleRefund}>
                    申請整單退款
                  </button>
                </div>
              )}
              {refunds.length > 0 && (
                <table className="data-table data-table--nested" aria-label="退款隊列">
                  <thead><tr><th style={{ width: '18%' }}>退款狀態</th><th style={{ width: '16%' }} className="col-numeric">金額</th><th style={{ width: '48%' }}>原因／失敗資訊</th><th style={{ width: '18%' }} className="col-actions">操作</th></tr></thead>
                  <tbody>{refunds.map((refund) => (
                    <tr key={refund.id}>
                      <td><StatusBadge value={refund.status} /></td>
                      <td className="col-numeric">{formatMoney(refund.amountCents, refund.currency)}</td>
                      <td><span className="cell-truncate" title={refund.failureMessage ?? refund.reason}>{refund.failureMessage ?? refund.reason}</span></td>
                      <td className="col-actions">{refund.status === 'failed' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => handleRetryRefund(refund.id)}><Icon name="refresh" /> 重試退款</button> : <span className="text-muted">—</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
