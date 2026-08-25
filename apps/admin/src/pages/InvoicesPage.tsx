import { useEffect, useState } from 'react';
import { api, type Invoice } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';

const STATUSES: Invoice['status'][] = ['pending', 'issued', 'issue_failed', 'void_pending', 'voided', 'void_failed'];

function carrierLabel(carrier: Invoice['carrier']): string {
  switch (carrier.kind) {
    case 'mobile': return `手機條碼 ${carrier.number}`;
    case 'natural_person': return `自然人憑證 ${carrier.number}`;
    case 'donation': return `捐贈 ${carrier.loveCode}`;
    default: return '綠界會員載具';
  }
}

export function InvoicesPage() {
  const { statusLabel, formatMoney } = useI18n();
  const [status, setStatus] = useState<Invoice['status'] | ''>('');
  const [items, setItems] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    api.listInvoices({ ...(status === '' ? {} : { status }), limit: 50 })
      .then((result) => { if (!cancelled) setItems(result.items); })
      .catch((reason) => !cancelled && setError(reason))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [status, reloadKey]);

  const retry = async (action: () => Promise<unknown>) => {
    setSubmitting(true); setError(null);
    try { await action(); setReloadKey((value) => value + 1); }
    catch (reason) { setError(reason); } finally { setSubmitting(false); }
  };

  return <section>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <p className="muted">開立與作廢由付款與退款事件驅動，這裡只查得到結果、重送卡住的那一次。</p>
    <div className="inline-form">
      <label>發票狀態<select aria-label="發票狀態" value={status} onChange={(event) => setStatus(event.target.value as Invoice['status'] | '')}>
        <option value="">全部狀態</option>
        {STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
      </select></label>
    </div>
    {loading ? <Loading /> : items.length === 0 ? <p className="muted">這個狀態下目前沒有發票紀錄。</p> : <div className="table-wrap"><table className="data-table data-table--fixed">
      <thead><tr>
        <th style={{ width: '8%' }}>訂單</th>
        <th style={{ width: '8%' }}>狀態</th>
        <th style={{ width: '11%' }}>發票號碼</th>
        <th style={{ width: '12%' }}>開立日期</th>
        <th style={{ width: '13%' }}>載具</th>
        <th style={{ width: '13%' }} className="col-numeric">金額 / 稅額</th>
        <th style={{ width: '8%' }} className="col-numeric">嘗試次數</th>
        <th style={{ width: '17%' }}>最後錯誤</th>
        <th style={{ width: '10%' }} className="col-actions">操作</th>
      </tr></thead>
      <tbody>{items.map((invoice) => <tr key={invoice.id}>
        <td className="mono">{invoice.orderNumber}</td>
        <td><StatusBadge value={invoice.status} /></td>
        <td className="mono">{invoice.invoiceNumber ?? '—'}</td>
        <td>{invoice.invoiceDate ?? '—'}</td>
        <td><span className="cell-truncate" title={carrierLabel(invoice.carrier)}>{carrierLabel(invoice.carrier)}</span></td>
        <td className="col-numeric">{formatMoney(invoice.amountCents, invoice.currency)} / {formatMoney(invoice.taxCents, invoice.currency)}</td>
        <td className="col-numeric">{invoice.issueAttempts} / {invoice.voidAttempts}</td>
        <td>{invoice.lastError ? <span className="cell-truncate" title={invoice.lastError}>{invoice.lastError}</span> : '—'}</td>
        <td className="col-actions">
          {invoice.status === 'issue_failed' || invoice.status === 'pending' ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void retry(() => api.retryInvoiceIssue(invoice.id))}><Icon name="send" /> 重送開立</button> : null}
          {invoice.status === 'void_failed' || invoice.status === 'void_pending' ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void retry(() => api.retryInvoiceVoid(invoice.id))}><Icon name="send" /> 重送作廢</button> : null}
        </td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
