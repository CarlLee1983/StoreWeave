import { useEffect, useState } from 'react';
import { api, type LifecycleDelivery } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

const STATUSES: LifecycleDelivery['status'][] = ['pending', 'sent', 'failed'];

export function NotificationsPage() {
  const { t, statusLabel, formatDateTime } = useI18n();
  const [status, setStatus] = useState<LifecycleDelivery['status'] | ''>('');
  const [orderIdInput, setOrderIdInput] = useState('');
  const [orderId, setOrderId] = useState('');
  const [items, setItems] = useState<LifecycleDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    api.listLifecycleDeliveries({ ...(status === '' ? {} : { status }), ...(orderId === '' ? {} : { orderId }), limit: 50 })
      .then((result) => { if (!cancelled) setItems(result.items); })
      .catch((reason) => !cancelled && setError(reason))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [status, orderId]);

  return <section>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <p className="muted">{t('notificationNoResendHint')}</p>
    <div className="inline-form">
      <label>{t('deliveryStatus')}<select aria-label={t('deliveryStatus')} value={status} onChange={(event) => setStatus(event.target.value as LifecycleDelivery['status'] | '')}>
        <option value="">{t('allStatuses')}</option>
        {STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
      </select></label>
      <label>{t('orderId')}<input aria-label={t('orderId')} value={orderIdInput} onChange={(event) => setOrderIdInput(event.target.value)} /></label>
      <button className="button" type="button" onClick={() => setOrderId(orderIdInput.trim())}>{t('search')}</button>
    </div>
    {loading && items.length === 0 ? <Loading /> : items.length === 0 ? <p className="muted">{t('noDeliveries')}</p> : <div className="table-wrap"><table className="data-table data-table--fixed">
      <thead><tr>
        <th style={{ width: '22%' }}>{t('notificationTemplate')}</th>
        <th style={{ width: '9%' }}>{t('status')}</th>
        <th style={{ width: '14%' }}>{t('recipient')}</th>
        <th style={{ width: '9%' }} className="col-numeric">{t('attempts')}</th>
        <th style={{ width: '20%' }}>{t('lastError')}</th>
        <th style={{ width: '13%' }}>{t('sentAt')}</th>
        <th style={{ width: '13%' }}>{t('orderId')}</th>
      </tr></thead>
      <tbody>{items.map((delivery) => <tr key={delivery.id}>
        <td><span className="cell-truncate mono" title={delivery.template}>{delivery.template}</span></td>
        <td><StatusBadge value={delivery.status} /></td>
        <td><span className="cell-truncate mono" title={delivery.recipientMasked}>{delivery.recipientMasked}</span></td>
        <td className="col-numeric">{delivery.attempts}</td>
        <td>{delivery.lastError ? <span className="cell-truncate" title={delivery.lastError}>{delivery.lastError}</span> : '—'}</td>
        <td>{delivery.sentAt ? formatDateTime(delivery.sentAt) : '—'}</td>
        <td><span className="cell-truncate mono" title={delivery.orderId}>{delivery.orderId}</span></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
