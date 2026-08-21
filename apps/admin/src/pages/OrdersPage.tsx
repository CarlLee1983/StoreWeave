import { useEffect, useState } from 'react';
import { api, formatMoney, getDisplayLocale, type Order } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

export function OrdersPage() {
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

      <div className="pipeline" aria-label="ERP 處理管線">
        <span>Ingest</span><b>{orders.length}</b><i>→</i><span>Queue</span><b>{pending.length}</b><i>→</i><span>Worker</span><b>Active</b><i>→</i><span>DLQ</span><b className="pipeline__alert">{orders.filter((order) => order.status === 'cancelled').length}</b>
      </div>
      <div className="summary-cards summary-cards--orders">
        <Metric label="交易總額" value={formatMoney(gmv, orders[0]?.currency ?? 'TWD')} />
        <Metric label="待處理訂單" value={String(pending.length)} />
        <Metric label="已完成訂單" value={String(paid.length)} />
        <Metric label="目前顯示" value={String(orders.length)} />
      </div>

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部狀態</option>
          <option value="pending">待付款</option>
          <option value="payment_processing">付款處理中</option>
          <option value="paid">已付款</option>
          <option value="cancelled">已取消</option>
          <option value="expired">付款逾時</option>
        </select>
      </div>

      {loading ? (
        <Loading />
      ) : (
        <div className="table-wrap"><table className="data-table">
          <thead>
            <tr>
              <th>訂單編號</th>
              <th>客戶</th>
              <th>狀態</th>
              <th>總金額</th>
              <th>下單時間</th>
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
      setError(new Error('請輸入取消原因'));
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
        <td className="mono">{new Intl.DateTimeFormat(getDisplayLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(order.placedAt))}</td>
        <td>{expanded ? '收合' : '檢視'}</td>
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
                    <th>名稱</th>
                    <th>單價</th>
                    <th>數量</th>
                    <th>小計</th>
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
                    要求付款
                  </button>
                  <input placeholder="取消原因" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button className="button" type="button" disabled={submitting} onClick={handleCancel}>
                    取消訂單
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
