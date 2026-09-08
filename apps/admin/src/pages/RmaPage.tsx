import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Rma, type RmaLine } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { ReasonDialog } from '../components/ReasonDialog';
import { rmaKeys } from '../query';
import { type AdminOperationEntry, useAdminOperationEntries } from '../admin-operations';
import { isRmaOperationEntry, isRmaReasonOperation, rmaScope, type RmaOperation, type RmaOperationResource, useRmaCommand } from '../rma-operations';

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
  const input = { status: status || undefined, orderId: orderId || undefined, limit: 50, offset: 0 };
  const rmasQuery = useQuery({ queryKey: rmaKeys.list(input), queryFn: ({ signal }) => api.listRmas(input, signal) });
  const items = rmasQuery.isSuccess ? rmasQuery.data.items : [];
  const recoveries = useAdminOperationEntries().filter(isRmaOperationEntry);
  const [recoveryError, setRecoveryError] = useState<unknown>(null);

  return <section>
    {rmasQuery.isError ? <ErrorBanner error={rmasQuery.error} onRetry={() => void rmasQuery.refetch()} /> : null}
    {recoveryError ? <ErrorBanner error={recoveryError} onDismiss={() => setRecoveryError(null)} /> : null}
    <div className="inline-form">
      <label>{t('rmaStatus')}<select aria-label={t('rmaStatus')} value={status} onChange={(event) => setStatus(event.target.value as Rma['status'] | '')}>
        <option value="">{t('allStatuses')}</option>
        {STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
      </select></label>
      <label>{t('orderId')}<input aria-label={t('orderId')} value={orderIdInput} onChange={(event) => setOrderIdInput(event.target.value)} /></label>
      <button className="button" type="button" onClick={() => setOrderId(orderIdInput.trim())}>{t('search')}</button>
    </div>
    {rmasQuery.isLoading ? <Loading /> : rmasQuery.isSuccess ? items.length === 0 ? <p className="muted">{t('noRmasForStatus')}</p> : items.map((rma) => <RmaCard key={rma.id} rma={rma} />) : null}
    {recoveries.filter((entry) => !items.some((rma) => rma.id === entry.operation.rmaId)).map((entry) => <RmaRecovery key={entry.operation.idempotencyKey} entry={entry} onTerminalError={setRecoveryError} />)}
  </section>;
}

function RmaRecovery({ entry, onTerminalError }: { entry: AdminOperationEntry<RmaOperation>; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const runCommand = useRmaCommand();
  const [submitting, setSubmitting] = useState(false);
  const retry = async () => { setSubmitting(true); const result = await runCommand(entry.operation, entry); if (result.state === 'rejected') onTerminalError(result.error); setSubmitting(false); };
  return <section className="account-panel" aria-label={`${t('rmas')} ${entry.operation.rmaId}`}><div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('productOperationPending') : t('unknownError')}</strong>{entry.phase === 'unknown' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}</div><RmaOperationPreview operation={entry.operation} /></section>;
}

function RmaOperationPreview({ operation }: { operation: RmaOperation }) {
  const { t } = useI18n();
  const label = operation.kind === 'approve' ? t('approveReturn') : operation.kind === 'information' ? t('requestInformation') : operation.kind === 'reject' ? t('rejectReturn') : operation.kind === 'receive' ? t('receiveReturn') : operation.kind === 'refund' ? t('requestRefund') : t('retryRefund');
  return <dl className="order-totals"><dt>{t('rmaCase')}</dt><dd className="mono">{operation.rmaId}</dd><dt>{t('orderId')}</dt><dd className="mono">{operation.resource.orderId}</dd><dt>{t('actions')}</dt><dd>{label}</dd>{operation.resource.lines.map((line) => <Fragment key={line.rmaLineId}><dt>{t('products')}</dt><dd>{line.name} · {line.sku} × {line.quantity}</dd></Fragment>)}{operation.kind === 'approve' ? <><dt>{t('staffNote')}</dt><dd>{operation.draft.note || '—'}</dd></> : null}{operation.kind === 'information' || operation.kind === 'reject' || operation.kind === 'refund' ? <><dt>{t('returnReason')}</dt><dd>{operation.draft.reason || '—'}</dd></> : null}{operation.kind === 'retry-refund' ? <><dt>{t('refundRecord')}</dt><dd className="mono">{operation.request.refundId}</dd></> : null}{operation.kind === 'receive' ? operation.draft.lines.map((line) => <Fragment key={line.rmaLineId}><dt>{t('disposition')} · <code>{line.rmaLineId}</code></dt><dd>{line.disposition === 'restock' ? t('restock') : `${t('discard')} · ${line.discardReason || '—'}`}</dd></Fragment>) : null}</dl>;
}

function rmaResource(rma: Rma): RmaOperationResource {
  return { orderId: rma.orderId, lines: rma.lines.map((line) => ({ rmaLineId: line.id, sku: line.sku, name: line.name, quantity: line.quantity })) };
}

function RmaCard({ rma }: { rma: Rma }) {
  const { formatMoney, formatDateTime, t } = useI18n();
  const runCommand = useRmaCommand();
  const recovery = useAdminOperationEntries().filter(isRmaOperationEntry).find((entry) => entry.operation.scope === rmaScope(rma.id)) ?? null;
  const [note, setNote] = useState(() => recovery?.operation.kind === 'approve' ? recovery.operation.draft.note : '');
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>(
    () => Object.fromEntries(rma.lines.map((line) => {
      const saved = recovery?.operation.kind === 'receive' ? recovery.operation.draft.lines.find((draft) => draft.rmaLineId === line.id) : undefined;
      return [line.id, saved ?? { disposition: 'restock' as const, discardReason: '' }];
    })),
  );
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [reasonTarget, setReasonTarget] = useState<{ action: 'information' | 'reject'; returnFocus: HTMLElement | null } | null>(null);
  const recoveryReason = recovery && isRmaReasonOperation(recovery.operation) ? recovery.operation : null;
  const recoveryRetryRef = useRef<HTMLButtonElement>(null);

  const run = async (operation: RmaOperation, retryEntry?: AdminOperationEntry<RmaOperation>) => {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    setSubmitting(true); setError(null);
    try {
      const result = await runCommand(operation, retryEntry);
      if (result.state === 'success') return true;
      if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
      return false;
    } finally { submittingRef.current = false; setSubmitting(false); }
  };
  // 補件與拒絕的理由會回到顧客眼前，收在專屬對話框裡才知道這段字屬於哪個動作。
  const submitReason = async (reason: string) => {
    const target = reasonTarget;
    if (!target) return;
    const succeeded = await run({ area: 'rma', scope: rmaScope(rma.id), kind: target.action, rmaId: rma.id, resource: rmaResource(rma), request: { reason }, draft: { reason }, idempotencyKey: crypto.randomUUID() });
    if (succeeded) setReasonTarget(null);
  };
  const receive = () => {
    const lines = rma.lines.map((line) => {
      const chosen = dispositions[line.id];
      return chosen.disposition === 'discard'
        ? { rmaLineId: line.id, disposition: 'discard' as const, discardReason: chosen.discardReason.trim() }
        : { rmaLineId: line.id, disposition: 'restock' as const };
    });
    if (lines.some((line) => line.disposition === 'discard' && !line.discardReason)) {
      setError(new Error(t('invalidDiscardReason'))); return;
    }
    void run({ area: 'rma', scope: rmaScope(rma.id), kind: 'receive', rmaId: rma.id, resource: rmaResource(rma), request: { lines }, draft: { lines: rma.lines.map((line) => ({ rmaLineId: line.id, ...dispositions[line.id] })) }, idempotencyKey: crypto.randomUUID() });
  };

  const menuItems: RowMenuItem[] = [
    ...(canRequestInformation(rma.status)
      ? [{ key: 'information', label: t('requestInformation'), icon: 'file-text' as const, onSelect: (returnFocus: HTMLButtonElement | null) => setReasonTarget({ action: 'information', returnFocus }) }]
      : []),
    ...(canReject(rma.status)
      ? [{ key: 'reject', label: t('rejectAction'), icon: 'ban' as const, danger: true, onSelect: (returnFocus: HTMLButtonElement | null) => setReasonTarget({ action: 'reject', returnFocus }) }]
      : []),
  ];

  return <section className="account-panel" aria-label={`${t('rmas')} ${rma.id}`}>
    <div className="section-heading">
      <h2>{t('rmaCase')} <code>{rma.id}</code></h2>
      <p>{t('orders')} <code>{rma.orderId}</code> · {t('requested')} {formatDateTime(rma.createdAt)}</p>
    </div>
    {error && !reasonTarget ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    {recovery?.phase === 'unknown' ? <div className="error-banner" role="status"><strong>{t('unknownError')}</strong><span>{rma.id}</span><button className="button button--quiet" type="button" disabled={submitting} onClick={() => void run(recovery.operation, recovery)}>{t('retryOriginalOperation')}</button>{recoveryReason ? <button className="button button--quiet" type="button" onClick={() => setReasonTarget({ action: recoveryReason.kind, returnFocus: null })}>{t('inspectOriginalOperation')}</button> : null}</div> : null}
    {recovery ? <RmaOperationPreview operation={recovery.operation} /> : null}
    <dl className="order-totals">
      <dt>{t('status')}</dt><dd><StatusBadge value={rma.status} /></dd>
      <dt>{t('returnReason')}</dt><dd>{rma.reason}</dd>
      <dt>{t('staffNote')}</dt><dd>{rma.staffNote ?? '—'}</dd>
      <dt>{t('refundRecord')}</dt><dd className="mono">{rma.refundId ?? '—'}</dd>
      <dt>{t('receivedAt')}</dt><dd>{rma.receivedAt ? formatDateTime(rma.receivedAt) : '—'}</dd>
      <dt>{t('completedAt')}</dt><dd>{rma.completedAt ? formatDateTime(rma.completedAt) : '—'}</dd>
    </dl>
    <div className="table-wrap"><table className="data-table data-table--fixed">
      <thead><tr><th style={{ width: '16%' }}>SKU</th><th style={{ width: '30%' }}>{t('products')}</th><th style={{ width: '12%' }} className="col-numeric">{t('returnQuantity')}</th><th style={{ width: '18%' }} className="col-numeric">{t('originalOrderLineNetTotal')}</th><th style={{ width: '24%' }}>{t('disposition')}</th></tr></thead>
      <tbody>{rma.lines.map((line) => <tr key={line.id}>
        <td className="mono">{line.sku}</td>
        <td><span className="cell-truncate" title={line.name}>{line.name}</span></td>
        <td className="col-numeric">{line.quantity}</td>
        <td className="col-numeric">{formatMoney(line.lineTotalCents - line.discountCents, 'TWD')}</td>
        <td>{canReceive(rma.status)
          ? <DispositionFields line={line} value={dispositions[line.id]} disabled={!!recovery} onChange={(next) => setDispositions((current) => ({ ...current, [line.id]: next }))} />
          : line.disposition ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="muted">{t('returnAmountHint')}</p>
    <div className="rma-card-actions">
      {canApprove(rma.status)
        ? <label className="rma-note-field">{t('optionalStaffNote')}<input aria-label={t('optionalStaffNote')} value={note} readOnly={!!recovery} onChange={(event) => setNote(event.target.value)} placeholder={t('optionalStaffNotePlaceholder')} /></label>
        : null}
      <div className="product-actions-row">
        {canApprove(rma.status) ? <button className="button button--primary" type="button" disabled={submitting || !!recovery} onClick={() => void run({ area: 'rma', scope: rmaScope(rma.id), kind: 'approve', rmaId: rma.id, resource: rmaResource(rma), request: { note: note.trim() || undefined }, draft: { note }, idempotencyKey: crypto.randomUUID() })}><Icon name="check" /> {t('approveReturn')}</button> : null}
        {canReceive(rma.status) ? <button className="button button--primary" type="button" disabled={submitting || !!recovery} onClick={receive}><Icon name="box" /> {t('receiveReturn')}</button> : null}
        {canRequestRefund(rma.status) ? <button className="button button--primary" type="button" disabled={submitting || !!recovery} onClick={() => void run({ area: 'rma', scope: rmaScope(rma.id), kind: 'refund', rmaId: rma.id, resource: rmaResource(rma), request: {}, draft: { reason: '' }, idempotencyKey: crypto.randomUUID() })}><Icon name="send" /> {t('requestRefund')}</button> : null}
        {menuItems.length > 0 ? <RowMenu items={menuItems} label={t('moreActions')} disabled={submitting || !!recovery} /> : null}
      </div>
    </div>

    {reasonTarget ? (
      <ReasonDialog
        title={reasonTarget.action === 'information' ? t('requestInformation') : t('rejectReturn')}
        description={reasonTarget.action === 'information'
          ? t('rmaInformationCustomerDescription')
          : t('rmaRejectionCustomerDescription')}
        confirmLabel={reasonTarget.action === 'information' ? t('submitCorrection') : t('rejectAction')}
        placeholder={reasonTarget.action === 'information' ? t('rmaInformationPlaceholder') : t('rmaRejectionPlaceholder')}
        danger={reasonTarget.action === 'reject'}
        error={error}
        onDismissError={() => setError(null)}
        labels={{ close: t('close'), cancel: t('cancel'), invalidReason: t('invalidReason'), submitting: t('submitting') }}
        returnFocus={reasonTarget.returnFocus}
        initialReason={recoveryReason?.kind === reasonTarget.action ? recoveryReason.draft.reason : ''}
        readOnly={recoveryReason?.kind === reasonTarget.action}
        recoveryFocusRef={recoveryRetryRef}
        recoveryReady={recovery?.phase === 'unknown' && recoveryReason?.kind === reasonTarget.action && !submitting}
        recoveryAction={recovery && recoveryReason?.kind === reasonTarget.action && recovery.phase === 'unknown' ? <button ref={recoveryRetryRef} className="button button--primary" type="button" disabled={submitting} onClick={() => void run(recovery.operation, recovery)}>{t('retryOriginalOperation')}</button> : null}
        onClose={() => setReasonTarget(null)}
        onConfirm={submitReason}
      />
    ) : null}
  </section>;
}

function DispositionFields({ line, value, disabled, onChange }: { line: RmaLine; value: Disposition; disabled: boolean; onChange: (next: Disposition) => void }) {
  const { t } = useI18n();
  return <div className="inline-form">
    <select aria-label={`${line.name} ${t('disposition')}`} value={value.disposition} disabled={disabled} onChange={(event) => onChange({ ...value, disposition: event.target.value as Disposition['disposition'] })}>
      <option value="restock">{t('restock')}</option><option value="discard">{t('discard')}</option>
    </select>
    {value.disposition === 'discard'
      ? <input aria-label={`${line.name} ${t('discardReason')}`} value={value.discardReason} readOnly={disabled} onChange={(event) => onChange({ ...value, discardReason: event.target.value })} />
      : null}
  </div>;
}
