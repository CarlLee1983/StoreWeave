import { useEffect, useState } from 'react';
import { api, type Delivery, type DeliveryPayload } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

export function ErpPage() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [inspectedDelivery, setInspectedDelivery] = useState<Delivery | null>(null);

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
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      {loading ? (
        <Loading />
      ) : (
        <div className="table-wrap"><table className="data-table">
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
              <DeliveryRow key={delivery.orderId} delivery={delivery} onInspect={setInspectedDelivery} onResent={reload} />
            ))}
          </tbody>
        </table></div>
      )}
      {inspectedDelivery ? (
        <PayloadDrawer
          delivery={inspectedDelivery}
          onClose={() => setInspectedDelivery(null)}
          onResent={reload}
        />
      ) : null}
    </section>
  );
}

function DeliveryRow({ delivery, onInspect, onResent }: { delivery: Delivery; onInspect: (delivery: Delivery) => void; onResent: () => void }) {
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
      <td><StatusBadge value={delivery.status} /></td>
      <td className="mono">{delivery.attempts}</td>
      <td className="mono">{delivery.manualResends}</td>
      <td>{delivery.lastError ?? '—'}</td>
      <td>{delivery.remoteId ?? '—'}</td>
      <td>
        <button className="button button--quiet" type="button" onClick={() => onInspect(delivery)}>
          Payload
        </button>
        <button className="button" type="button" disabled={submitting} onClick={handleResend}>
          重送
        </button>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}

function PayloadDrawer({ delivery, onClose, onResent }: { delivery: Delivery; onClose: () => void; onResent: () => void }) {
  const [result, setResult] = useState<DeliveryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [resending, setResending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.inspectDeliveryPayload(delivery.orderId)
      .then((payload) => !cancelled && setResult(payload))
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [delivery.orderId]);

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.payload, null, 2));
      setCopyState('copied');
    } catch (err) {
      setError(err);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    try {
      await api.resendOrder(delivery.orderId);
      onResent();
    } catch (err) {
      setError(err);
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <aside className="payload-drawer" role="dialog" aria-modal="true" aria-label={`ERP payload：${delivery.orderNumber}`} onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2>ERP Payload</h2><p>{delivery.orderNumber} · {delivery.reference}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="關閉 Payload">×</button></header>
        <p className="payload-drawer__notice">此預覽由目前 ERP 設定產生，下一次重送會使用相同 HTTP JSON body；不包含 API key。</p>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
        {loading ? <Loading /> : <pre>{result ? JSON.stringify(result.payload, null, 2) : ''}</pre>}
        <footer><button className="button button--quiet" type="button" disabled={!result} onClick={copy}>{copyState === 'copied' ? '已複製' : '複製 JSON'}</button><button className="button button--primary" type="button" disabled={resending} onClick={resend}>{resending ? '重送中…' : '重送至 ERP'}</button></footer>
      </aside>
    </div>
  );
}
