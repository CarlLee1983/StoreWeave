import { useEffect, useState } from 'react';
import { api, type Delivery, type DeliveryPayload } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { useEscapeKey } from '../hooks/useEscapeKey';

export function ErpPage() {
  const { t } = useI18n();
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
        <div className="table-wrap"><table className="data-table data-table--fixed">
          <thead>
            <tr>
              <th style={{ width: '13%' }}>{t('orderNumber')}</th>
              <th style={{ width: '13%' }}>{t('reference')}</th>
              <th style={{ width: '9%' }}>{t('status')}</th>
              <th style={{ width: '8%' }} className="col-numeric" title={t('attempts')}>{t('attempts')}</th>
              <th style={{ width: '11%' }} className="col-numeric" title={t('manualResends')}>{t('manualResends')}</th>
              <th style={{ width: '20%' }}>{t('lastError')}</th>
              <th style={{ width: '12%' }}>{t('remoteId')}</th>
              <th style={{ width: '14%' }} className="col-actions">操作</th>
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
  const { t } = useI18n();
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

  const menuItems: RowMenuItem[] = [
    { key: 'resend', label: t('resend'), icon: 'send', onSelect: () => void handleResend() },
  ];

  return (
    <tr>
      <td className="mono">{delivery.orderNumber}</td>
      <td><span className="cell-truncate" title={delivery.reference}>{delivery.reference}</span></td>
      <td><StatusBadge value={delivery.status} /></td>
      <td className="col-numeric">{delivery.attempts}</td>
      <td className="col-numeric">{delivery.manualResends}</td>
      <td>
        {delivery.lastError ? <span className="cell-truncate" title={delivery.lastError}>{delivery.lastError}</span> : '—'}
      </td>
      <td>
        {delivery.remoteId ? <span className="cell-truncate mono" title={delivery.remoteId}>{delivery.remoteId}</span> : '—'}
      </td>
      <td className="col-actions">
        <div className="product-actions-row">
          <button className="button button--quiet" type="button" onClick={() => onInspect(delivery)}>
            <Icon name="file-text" /> {t('payload')}
          </button>
          <RowMenu disabled={submitting} items={menuItems} />
        </div>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}

function PayloadDrawer({ delivery, onClose, onResent }: { delivery: Delivery; onClose: () => void; onResent: () => void }) {
  const { t } = useI18n();
  const [result, setResult] = useState<DeliveryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [resending, setResending] = useState(false);

  useEscapeKey(onClose);

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
      <aside className="payload-drawer" role="dialog" aria-modal="true" aria-label={`${t('payloadDialog')}: ${delivery.orderNumber}`} onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2>{t('payloadDialog')}</h2><p>{delivery.orderNumber} · {delivery.reference}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label={t('closePayload')}><Icon name="close" /></button></header>
        <p className="payload-drawer__notice">{t('payloadNotice')}</p>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
        {loading ? <Loading /> : <pre>{result ? JSON.stringify(result.payload, null, 2) : ''}</pre>}
        <footer><button className="button button--quiet" type="button" disabled={!result} onClick={copy}>{copyState === 'copied' ? t('copied') : t('copyJson')}</button><button className="button button--primary" type="button" disabled={resending} onClick={resend}>{resending ? t('resending') : t('resendToErp')}</button></footer>
      </aside>
    </div>
  );
}
