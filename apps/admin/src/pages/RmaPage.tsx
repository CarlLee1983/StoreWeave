import { useEffect, useState } from 'react';
import { api, type Rma, type RmaLine } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ReasonDialog } from '../components/ReasonDialog';

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
  const [reasonAction, setReasonAction] = useState<'information' | 'reject' | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setSubmitting(true); setError(null);
    try { await action(); onChanged(); } catch (reason) { setError(reason); } finally { setSubmitting(false); }
  };
  // 補件與拒絕的理由會回到顧客眼前，收在專屬對話框裡才知道這段字屬於哪個動作。
  const submitReason = (reason: string) => {
    const action = reasonAction;
    if (!action) return;
    setReasonAction(null);
    void run(() => action === 'information'
      ? api.requestRmaInformation(rma.id, reason)
      : api.rejectRma(rma.id, reason));
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

  const menuItems: RowMenuItem[] = [
    ...(canRequestInformation(rma.status)
      ? [{ key: 'information', label: '要求補件', icon: 'file-text' as const, onSelect: () => setReasonAction('information') }]
      : []),
    ...(canReject(rma.status)
      ? [{ key: 'reject', label: '拒絕', icon: 'ban' as const, danger: true, onSelect: () => setReasonAction('reject') }]
      : []),
  ];

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
    <div className="table-wrap"><table className="data-table data-table--fixed">
      <thead><tr><th style={{ width: '16%' }}>SKU</th><th style={{ width: '30%' }}>商品</th><th style={{ width: '12%' }} className="col-numeric">退貨數量</th><th style={{ width: '18%' }} className="col-numeric">原訂單行折後淨額</th><th style={{ width: '24%' }}>處置</th></tr></thead>
      <tbody>{rma.lines.map((line) => <tr key={line.id}>
        <td className="mono">{line.sku}</td>
        <td><span className="cell-truncate" title={line.name}>{line.name}</span></td>
        <td className="col-numeric">{line.quantity}</td>
        <td className="col-numeric">{formatMoney(line.lineTotalCents - line.discountCents, 'TWD')}</td>
        <td>{canReceive(rma.status)
          ? <DispositionFields line={line} value={dispositions[line.id]} onChange={(next) => setDispositions((current) => ({ ...current, [line.id]: next }))} />
          : line.disposition ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="muted">金額是這一整行訂單行的折後淨額；實際退款由伺服器依退貨數量佔比計算，不一定等於這個數字。</p>
    <div className="rma-card-actions">
      {canApprove(rma.status)
        ? <label className="rma-note-field">店員備註<input aria-label="店員備註" value={note} onChange={(event) => setNote(event.target.value)} placeholder="選填，會寫進案件紀錄" /></label>
        : null}
      <div className="product-actions-row">
        {canApprove(rma.status) ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void run(() => api.approveRma(rma.id, note.trim() || undefined))}><Icon name="check" /> 核准</button> : null}
        {canReceive(rma.status) ? <button className="button button--primary" type="button" disabled={submitting} onClick={receive}><Icon name="box" /> 登記收件</button> : null}
        {canRequestRefund(rma.status) ? <button className="button button--primary" type="button" disabled={submitting} onClick={() => void run(() => api.requestRmaRefund(rma.id))}><Icon name="send" /> 請求退款</button> : null}
        {menuItems.length > 0 ? <RowMenu items={menuItems} disabled={submitting} /> : null}
      </div>
    </div>

    {reasonAction ? (
      <ReasonDialog
        title={reasonAction === 'information' ? '要求補件' : '拒絕退貨'}
        description={reasonAction === 'information'
          ? '說明還需要顧客補充哪些資料，內容會回到顧客眼前。'
          : '拒絕會結束這件退貨，原因會回到顧客眼前。'}
        confirmLabel={reasonAction === 'information' ? '送出' : '拒絕'}
        placeholder={reasonAction === 'information' ? '例如：請補拍外包裝與瑕疵處照片' : '例如：不符合退貨條件'}
        danger={reasonAction === 'reject'}
        onClose={() => setReasonAction(null)}
        onConfirm={submitReason}
      />
    ) : null}
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
