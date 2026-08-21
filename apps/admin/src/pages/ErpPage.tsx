import { useEffect, useState } from 'react';
import { api, type Delivery } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';

export function ErpPage() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listDeliveries()
      .then((result) => !cancelled && setDeliveries(result.items))
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <section>
      <h2>ERP 投遞狀態</h2>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      {loading ? (
        <Loading />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>訂單編號</th>
              <th>參考碼</th>
              <th>狀態</th>
              <th>嘗試次數</th>
              <th>手動重送次數</th>
              <th>最後錯誤</th>
              <th>遠端 ID</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deliveries.map((delivery) => (
              <DeliveryRow key={delivery.orderId} delivery={delivery} onResent={reload} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DeliveryRow({ delivery, onResent }: { delivery: Delivery; onResent: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleResend = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.resendOrder(delivery.orderId);
      onResent();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <tr>
      <td>{delivery.orderNumber}</td>
      <td>{delivery.reference}</td>
      <td>{delivery.status}</td>
      <td>{delivery.attempts}</td>
      <td>{delivery.manualResends}</td>
      <td>{delivery.lastError ?? '—'}</td>
      <td>{delivery.remoteId ?? '—'}</td>
      <td>
        <button type="button" disabled={submitting} onClick={handleResend}>
          重送
        </button>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}
