import { useEffect, useState } from 'react';
import { api, formatMoney, type Order } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';

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

  return (
    <section>
      <h2>訂單管理</h2>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

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
        <table className="data-table">
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
        </table>
      )}
    </section>
  );
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
        <td>{order.status}</td>
        <td>{formatMoney(order.totalCents, order.currency)}</td>
        <td>{new Date(order.placedAt).toLocaleString('zh-TW')}</td>
        <td>{expanded ? '收合 ▲' : '展開 ▼'}</td>
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
                  <button type="button" disabled={submitting} onClick={handlePay}>
                    要求付款
                  </button>
                  <input placeholder="取消原因" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button type="button" disabled={submitting} onClick={handleCancel}>
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
