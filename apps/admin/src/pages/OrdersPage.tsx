import { useEffect, useState } from 'react';
import { api, type Order, type Refund, type Rma } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

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
  const runRmaAction = async (rma: Rma, action: 'approve' | 'information' | 'reject' | 'receive' | 'refund' | 'retry') => {
    setError(null);
    try {
      if (action === 'approve') await api.approveRma(rma.id);
      if (action === 'information' || action === 'reject') {
        const note = window.prompt(action === 'information' ? '請輸入需要補充的資料' : '請輸入拒絕原因');
        if (!note?.trim()) return;
        if (action === 'information') await api.requestRmaInformation(rma.id, note.trim()); else await api.rejectRma(rma.id, note.trim());
      }
      if (action === 'receive') await api.receiveRma(rma.id, rma.lines.map((line) => ({ rmaLineId: line.id, disposition: 'restock' })));
      if (action === 'refund') await api.requestRmaRefund(rma.id);
      if (action === 'retry' && rma.refundId) await api.retryRefund(rma.refundId);
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
        <span>Ingest</span><b>{orders.length}</b><i>→</i><span>Queue</span><b>{pending.length}</b><i>→</i><span>Worker</span><b>Active</b><i>→</i><span>DLQ</span><b className="pipeline__alert">{orders.filter((order) => order.status === 'cancelled').length}</b>
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
          <div className="table-wrap"><table className="data-table"><thead><tr><th>訂單</th><th>狀態</th><th>金額</th><th>失敗原因</th><th /></tr></thead>
            <tbody>{refundQueue.map((refund) => <tr key={refund.id}>
              <td className="mono">{refund.orderId}</td><td><StatusBadge value={refund.status} /></td><td className="mono">{formatMoney(refund.amountCents, refund.currency)}</td><td>{refund.failureMessage ?? '—'}</td>
              <td>{refund.status === 'failed' ? <button className="button" type="button" onClick={() => void retryQueuedRefund(refund.id)}>重試退款</button> : null}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>

      <section className="account-panel" aria-label="退貨作業隊列">
        <div className="section-heading"><h2>退貨作業隊列</h2><p>換貨第一版採退款後重新下單；收件入庫只適用可回補的商品。</p></div>
        {rmaQueue.length === 0 ? <p className="muted">目前沒有退貨案件。</p> : (
          <div className="table-wrap"><table className="data-table"><thead><tr><th>訂單</th><th>品項</th><th>狀態</th><th>原因</th><th /></tr></thead>
            <tbody>{rmaQueue.map((rma) => <tr key={rma.id}>
              <td className="mono">{rma.orderId}</td><td>{rma.lines.map((line) => `${line.name} × ${line.quantity}`).join('、')}</td><td><StatusBadge value={rma.status} /></td><td>{rma.staffNote ?? rma.reason}</td>
              <td className="inline-form">
                {['requested', 'needs_information'].includes(rma.status) ? <button className="button" type="button" onClick={() => void runRmaAction(rma, 'approve')}>核准</button> : null}
                {['requested', 'approved'].includes(rma.status) ? <button className="button" type="button" onClick={() => void runRmaAction(rma, 'information')}>要求補件</button> : null}
                {['requested', 'needs_information', 'approved'].includes(rma.status) ? <button className="button" type="button" onClick={() => void runRmaAction(rma, 'reject')}>拒絕</button> : null}
                {rma.status === 'approved' ? <button className="button button--primary" type="button" onClick={() => void runRmaAction(rma, 'receive')}>收件並全部回補</button> : null}
                {rma.status === 'received' ? <button className="button button--primary" type="button" onClick={() => void runRmaAction(rma, 'refund')}>申請退款</button> : null}
                {rma.status === 'refund_failed' ? <button className="button" type="button" onClick={() => void runRmaAction(rma, 'retry')}>重試退款</button> : null}
              </td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>

      {loading ? (
        <Loading />
      ) : (
        <div className="table-wrap"><table className="data-table">
          <thead>
            <tr>
              <th>{t('orderNumber')}</th><th>{t('customer')}</th><th>{t('status')}</th><th>{t('total')}</th><th>{t('orderedAt')}</th>
              <th />
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
        <td>{order.number}</td>
        <td>{order.customerEmail}</td>
        <td><StatusBadge value={order.status} /></td>
        <td className="mono">{formatMoney(order.totalCents, order.currency)}</td>
        <td className="mono">{formatDateTime(order.placedAt)}</td><td>{expanded ? t('collapse') : t('view')}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <div className="order-detail">
              {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
              <table className="data-table data-table--nested">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>{t('name')}</th><th>{t('unitPrice')}</th><th>{t('quantity')}</th><th>{t('subtotal')}</th>
                    <th>{t('discount')}</th><th>{t('netAmount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.sku}</td>
                      <td>{line.name}</td>
                      <td>{formatMoney(line.unitPriceCents, order.currency)}</td>
                      <td>{line.quantity}</td>
                      <td>{formatMoney(line.lineTotalCents, order.currency)}</td>
                      <td className="mono">{line.discountCents > 0 ? `-${formatMoney(line.discountCents, order.currency)}` : '—'}</td>
                      <td className="mono">{formatMoney(line.lineTotalCents - line.discountCents, order.currency)}</td>
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
                  <thead><tr><th>退款狀態</th><th>金額</th><th>原因／失敗資訊</th><th /></tr></thead>
                  <tbody>{refunds.map((refund) => (
                    <tr key={refund.id}>
                      <td><StatusBadge value={refund.status} /></td>
                      <td className="mono">{formatMoney(refund.amountCents, refund.currency)}</td>
                      <td>{refund.failureMessage ?? refund.reason}</td>
                      <td>{refund.status === 'failed' ? <button className="button" type="button" disabled={submitting} onClick={() => handleRetryRefund(refund.id)}>重試退款</button> : null}</td>
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
