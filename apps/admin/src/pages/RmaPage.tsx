import { useEffect, useState } from 'react';
import { api, type Rma, type RmaLine } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

const STATUSES: Rma['status'][] = ['requested', 'needs_information', 'approved', 'rejected', 'received', 'refund_pending', 'refund_failed', 'completed'];

/** 與 rma module 的狀態機一致；頁面只是不讓店員送出會被拒的轉換。 */
const canApprove = (status: Rma['status']) => status === 'requested' || status === 'needs_information';
const canRequestInformation = (status: Rma['status']) => status === 'requested' || status === 'approved';
const canReject = (status: Rma['status']) => status === 'requested' || status === 'needs_information' || status === 'approved';
const canReceive = (status: Rma['status']) => status === 'approved';
const canRequestRefund = (status: Rma['status']) => status === 'received';

type Disposition = { disposition: 'restock' | 'discard'; discardReason: string };

export function RmaPage() {
  const { statusLabel, t } = useI18n();
  const [status, setStatus] = useState<Rma['status'] | ''>('requested');
  const [orderIdInput, setOrderIdInput] = useState('');
  const [orderId, setOrderId] = useState('');
  const [items, setItems] = useState<Rma[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    api.listRmas({ ...(status === '' ? {} : { status }), ...(orderId === '' ? {} : { orderId }), limit: 50 })
      .then((result) => { if (!cancelled) setItems(result.items); })
      .catch((reason) => !cancelled && setError(reason))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [status, orderId, reloadKey]);

  return <section>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <div className="inline-form">
      <label>案件狀態<select aria-label="案件狀態" value={status} onChange={(event) => setStatus(event.target.value as Rma['status'] | '')}>
        <option value="">全部狀態</option>
        {STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
      </select></label>
      <label>{t('orderId')}<input aria-label={t('orderId')} value={orderIdInput} onChange={(event) => setOrderIdInput(event.target.value)} /></label>
      <button className="button" type="button" onClick={() => setOrderId(orderIdInput.trim())}>{t('search')}</button>
    </div>
    {loading ? <Loading /> : items.length === 0
      ? <p className="muted">這個狀態下目前沒有退貨案件。</p>
      : items.map((rma) => <RmaCard key={rma.id} rma={rma} onChanged={() => setReloadKey((value) => value + 1)} />)}
  </section>;
}

function RmaCard({ rma, onChanged }: { rma: Rma; onChanged: () => void }) {
  const { formatMoney, formatDateTime } = useI18n();
  const [note, setNote] = useState('');
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>(
    () => Object.fromEntries(rma.lines.map((line) => [line.id, { disposition: 'restock' as const, discardReason: '' }])),
  );
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setSubmitting(true); setError(null);
    try { await action(); onChanged(); } catch (reason) { setError(reason); } finally { setSubmitting(false); }
  };
  const withNote = (action: (note: string) => Promise<unknown>) => {
    if (!note.trim()) { setError(new Error('請填寫備註：補件與拒絕都會回到顧客眼前。')); return; }
    void run(() => action(note.trim()));
  };
  const receive = () => {
    const lines = rma.lines.map((line) => {
      const chosen = dispositions[line.id];
      return chosen.disposition === 'discard'
        ? { rmaLineId: line.id, disposition: 'discard' as const, discardReason: chosen.discardReason.trim() }
        : { rmaLineId: line.id, disposition: 'restock' as const };
    });
    if (lines.some((line) => line.disposition === 'discard' && !line.discardReason)) {
      setError(new Error('報廢必須填寫原因：庫存不會自己回來，帳要對得起來。')); return;
    }
    void run(() => api.receiveRma(rma.id, lines));
  };

  return <section className="account-panel" aria-label={`退貨案件 ${rma.id}`}>
    <div className="section-heading">
      <h2>案件 <code>{rma.id}</code></h2>
      <p>訂單 <code>{rma.orderId}</code> · 申請於 {formatDateTime(rma.createdAt)}</p>
    </div>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <dl className="order-totals">
      <dt>狀態</dt><dd><StatusBadge value={rma.status} /></dd>
      <dt>申請原因</dt><dd>{rma.reason}</dd>
      <dt>店員備註</dt><dd>{rma.staffNote ?? '—'}</dd>
      <dt>退款紀錄</dt><dd className="mono">{rma.refundId ?? '—'}</dd>
      <dt>收件時間</dt><dd>{rma.receivedAt ? formatDateTime(rma.receivedAt) : '—'}</dd>
      <dt>結案時間</dt><dd>{rma.completedAt ? formatDateTime(rma.completedAt) : '—'}</dd>
    </dl>
    <div className="table-wrap"><table className="data-table">
      <thead><tr><th>SKU</th><th>商品</th><th>退貨數量</th><th>原訂單行折後淨額</th><th>處置</th></tr></thead>
      <tbody>{rma.lines.map((line) => <tr key={line.id}>
        <td className="mono">{line.sku}</td><td>{line.name}</td><td>{line.quantity}</td>
        <td className="mono">{formatMoney(line.lineTotalCents - line.discountCents, 'TWD')}</td>
        <td>{canReceive(rma.status)
          ? <DispositionFields line={line} value={dispositions[line.id]} onChange={(next) => setDispositions((current) => ({ ...current, [line.id]: next }))} />
          : line.disposition ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="muted">金額是這一整行訂單行的折後淨額；實際退款由伺服器依退貨數量佔比計算，不一定等於這個數字。</p>
    <div className="inline-form">
      <label>店員備註<input aria-label="店員備註" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      {canApprove(rma.status) ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void run(() => api.approveRma(rma.id, note.trim() || undefined))}>核准</button> : null}
      {canRequestInformation(rma.status) ? <button className="button" type="button" disabled={submitting} onClick={() => withNote((value) => api.requestRmaInformation(rma.id, value))}>要求補件</button> : null}
      {canReject(rma.status) ? <button className="button" type="button" disabled={submitting} onClick={() => withNote((value) => api.rejectRma(rma.id, value))}>拒絕</button> : null}
      {canReceive(rma.status) ? <button className="button button--primary" type="button" disabled={submitting} onClick={receive}>登記收件</button> : null}
      {canRequestRefund(rma.status) ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void run(() => api.requestRmaRefund(rma.id))}>請求退款</button> : null}
    </div>
  </section>;
}

function DispositionFields({ line, value, onChange }: { line: RmaLine; value: Disposition; onChange: (next: Disposition) => void }) {
  return <div className="inline-form">
    <select aria-label={`${line.name} 的處置`} value={value.disposition} onChange={(event) => onChange({ ...value, disposition: event.target.value as Disposition['disposition'] })}>
      <option value="restock">回補庫存</option><option value="discard">報廢</option>
    </select>
    {value.disposition === 'discard'
      ? <input aria-label={`${line.name} 的報廢原因`} value={value.discardReason} onChange={(event) => onChange({ ...value, discardReason: event.target.value })} />
      : null}
  </div>;
}
