import { useEffect, useState } from 'react';
import { api, type Order } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

export function OrdersPage() {
  const { t, formatMoney } = useI18n();
  const [status, setStatus] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listOrders({ status: status || undefined, limit: 50 })
      .then((result) => !cancelled && setOrders(result.items))
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [status, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
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
                    </tr>
                  ))}
                </tbody>
              </table>

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
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
