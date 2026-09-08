import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AdminCustomer, type AdminCustomerDetail, type CustomerLoyalty } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { DateField } from '../components/DateField';
import { customerKeys, loyaltyKeys } from '../query';
import { type AdminOperationEntry, useAdminOperationEntries } from '../admin-operations';
import { customerScope, isCustomerOperationEntry, type CustomerOperation, useCustomerCommand } from '../customer-operations';

export function CustomersPage() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const input = { q: q || undefined, status: status || undefined, limit: 50, offset: 0 };
  const customersQuery = useQuery({ queryKey: customerKeys.list(input), queryFn: ({ signal }) => api.listCustomers(input, signal) });
  const customers = customersQuery.isSuccess ? customersQuery.data.items : [];
  const total = customersQuery.isSuccess ? customersQuery.data.total : 0;
  const reload = () => void customersQuery.refetch();
  const recoveries = useAdminOperationEntries().filter(isCustomerOperationEntry);

  return (
    <section>
      <CustomerRecoveries entries={recoveries} />
      {customersQuery.isError ? <ErrorBanner error={customersQuery.error} onRetry={reload} /> : null}

      <div className="toolbar">
        <div className="toolbar__search-group">
          <Icon name="search" />
          <input aria-label={t('searchCustomers')} placeholder={t('searchCustomers')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('allStatuses')}</option>
          <option value="active">{t('enabledStatus')}</option>
          <option value="disabled">{t('disabled')}</option>
        </select>
        {total > customers.length ? <span>{`${customers.length} / ${total}`}</span> : null}
      </div>

      {customersQuery.isLoading ? (
        <Loading />
      ) : customersQuery.isSuccess && customers.length === 0 ? (
        <EmptyState icon="user" title={t('noCustomers')} hint={t('customersHint')} />
      ) : customersQuery.isSuccess ? (
        <div className="table-wrap"><table className="data-table data-table--fixed customers-table">
          <thead>
            <tr>
              <th style={{ width: '28%' }}>{t('email')}</th>
              <th style={{ width: '18%' }}>{t('name')}</th>
              <th style={{ width: '14%' }}>{t('phone')}</th>
              <th style={{ width: '14%' }}>{t('joinedAt')}</th>
              <th style={{ width: '12%' }}>{t('status')}</th>
              <th style={{ width: '14%' }} className="col-actions">{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} />
            ))}
          </tbody>
        </table></div>
      ) : null}
    </section>
  );
}

function CustomerRecoveries({ entries }: { entries: AdminOperationEntry<CustomerOperation>[] }) {
  const { t, formatMoney } = useI18n();
  const command = useCustomerCommand();
  const [error, setError] = useState<unknown>(null);
  if (!entries.length) return error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null;
  return <div className="command-recoveries" aria-live="polite">
    {entries.map((entry) => {
      const operation = entry.operation;
      const preview = operation.kind === 'status'
        ? `${t('customers')} · ${operation.customerId} · ${operation.request.status === 'active' ? t('enabledStatus') : t('disabled')}`
        : operation.kind === 'birthday'
          ? `${t('correctBirthday')} · ${operation.customerId} · ${operation.draft.birthday} · ${operation.draft.reason}`
          : operation.kind === 'rewards'
            ? `${t('adjustRewards')} · ${operation.customerId} · ${formatMoney(operation.request.amountCents, operation.draft.currency)} · ${operation.draft.reason}`
            : `${t('adjustTierPoints')} · ${operation.customerId} · ${operation.draft.points} · ${operation.draft.reason}`;
      return <div className="error-banner" role="status" key={operation.idempotencyKey}>
        <strong>{entry.phase === 'unknown' ? t('unknownError') : t('running')}</strong>
        <span>{preview}</span>
        {entry.phase === 'unknown' ? <button type="button" className="button button--quiet" onClick={() => void command(operation, entry).then((result) => { if (result.state === 'rejected') setError(result.error); })}>{t('retryOriginalOperation')}</button> : null}
      </div>;
    })}
  </div>;
}

function CustomerRow({ customer }: { customer: AdminCustomer }) {
  const { t, formatDate } = useI18n();
  const command = useCustomerCommand();
  const recovery = useAdminOperationEntries().filter(isCustomerOperationEntry).find((entry) => entry.operation.scope === customerScope.profile(customer.id)) ?? null;
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nextStatus: AdminCustomer['status'] = customer.status === 'active' ? 'disabled' : 'active';

  const detailQuery = useQuery({ queryKey: customerKeys.detail(customer.id), queryFn: ({ signal }) => api.getCustomer(customer.id, signal), enabled: expanded });
  const loyaltyQuery = useQuery({ queryKey: loyaltyKeys.customer(customer.id), queryFn: ({ signal }) => api.customerLoyalty(customer.id, signal), enabled: expanded });
  const detail = detailQuery.isSuccess ? detailQuery.data : null;
  const loyalty = loyaltyQuery.isSuccess ? loyaltyQuery.data : null;

  const toggleStatus = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const operation = { area: 'customer' as const, scope: customerScope.profile(customer.id), kind: 'status' as const, customerId: customer.id, request: { status: nextStatus }, draft: { status: nextStatus }, idempotencyKey: crypto.randomUUID() };
      const result = await command(operation, recovery?.operation.kind === 'status' ? recovery : undefined);
      if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <tr className="clickable" onClick={() => setExpanded((v) => !v)}>
        <td><span className="cell-truncate" title={customer.email}>{customer.email}</span></td>
        <td>{customer.displayName}</td>
        <td className="mono">{customer.phone ?? '—'}</td>
        <td className="mono">{formatDate(customer.createdAt)}</td>
        <td>
          <StatusBadge
            value={customer.status === 'active' ? 'active' : 'disabled'}
            label={customer.status === 'active' ? t('enabledStatus') : t('disabled')}
          />
        </td>
        <td className="col-actions">
          <button
            type="button"
            className="button button--quiet"
            disabled={submitting || !!recovery}
            onClick={(e) => {
              e.stopPropagation();
              void toggleStatus();
            }}
          >
            <Icon name={customer.status === 'active' ? 'pause' : 'play'} /> {customer.status === 'active' ? t('disable') : t('enable')}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <div className="order-detail">
              {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
              {detailQuery.isError ? <ErrorBanner error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> : null}
              {loyaltyQuery.isError ? <ErrorBanner error={loyaltyQuery.error} onRetry={() => void loyaltyQuery.refetch()} /> : null}
              {detailQuery.isLoading ? <Loading /> : detail ? (
                <div className="detail-cards">
                  <section className="detail-card">
                    <div className="detail-card__header">
                      <h4>{t('profile')}</h4>
                      <BirthdayCorrection customerId={customer.id} />
                    </div>
                    <dl className="order-totals">
                      <dt>{t('birthday')}</dt><dd>{detail.birthday ?? '—'}</dd>
                      <dt>{t('phone')}</dt><dd className="mono">{detail.phone ?? '—'}</dd>
                      <dt>{t('address')}</dt>
                      <dd>
                        {detail.address ? (
                          <span
                            className="cell-truncate"
                            title={`${detail.address.postcode} ${detail.address.city} ${detail.address.line1} ${detail.address.line2 ?? ''}`}
                          >
                            {`${detail.address.postcode} ${detail.address.city} ${detail.address.line1} ${detail.address.line2 ?? ''}`}
                          </span>
                        ) : '—'}
                      </dd>
                    </dl>
                  </section>

                  <section className="detail-card detail-card--wide">
                    <div className="detail-card__header"><h4>{t('orderHistory')}</h4></div>
                    {detail.orders.length === 0 ? <EmptyState icon="receipt" title={t('noOrders')} /> : (
                      <table className="data-table data-table--nested data-table--fixed">
                        <thead>
                          <tr>
                            <th style={{ width: '28%' }}>{t('orderNumber')}</th>
                            <th style={{ width: '20%' }}>{t('status')}</th>
                            <th style={{ width: '24%' }} className="col-numeric">{t('total')}</th>
                            <th style={{ width: '28%' }}>{t('orderedAt')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.orders.map((order) => (
                            <OrderRow key={order.id} order={order} />
                          ))}
                        </tbody>
                      </table>
                    )}
                  </section>
                </div>
              ) : null}
              {loyaltyQuery.isLoading ? <section className="detail-card"><Loading /></section> : loyalty ? <LoyaltyPanel customerId={customer.id} loyalty={loyalty} /> : null}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * 客服補償的入口。購物金與等級積分刻意分成兩個表單——它們是兩本帳，
 * 一個能折抵金額、一個只影響等級，共用一個輸入框只會讓人補錯。
 */
function LoyaltyPanel({ customerId, loyalty }: { customerId: string; loyalty: CustomerLoyalty }) {
  const { t, formatMoney, formatDateTime } = useI18n();
  return (
    <section className="detail-card">
      <div className="detail-card__header"><h4>{t('loyalty')}</h4></div>
      <dl className="order-totals">
        <dt>{t('rewardAvailable')}</dt><dd className="mono">{formatMoney(loyalty.balance.availableCents, loyalty.currency)}</dd>
        <dt>{t('rewardPending')}</dt><dd className="mono">{formatMoney(loyalty.balance.pendingCents, loyalty.currency)}</dd>
        <dt>{t('nextExpiry')}</dt>
        <dd className="mono">
          {loyalty.balance.nextExpiry
            ? `${formatMoney(loyalty.balance.nextExpiry.amountCents, loyalty.currency)} · ${formatDateTime(loyalty.balance.nextExpiry.expiresAt)}`
            : '—'}
        </dd>
        <dt>{t('memberTier')}</dt><dd>{loyalty.tierName}（{loyalty.tierPoints}）</dd>
      </dl>
      <div className="adjust-forms">
        <AdjustForm
          label={t('adjustRewards')}
          unit={t('rewardUnit')}
          customerId={customerId}
          currency={loyalty.currency}
          kind="rewards"
        />
        <AdjustForm
          label={t('adjustTierPoints')}
          unit={t('tierPointUnit')}
          customerId={customerId}
          kind="tier-points"
        />
      </div>
    </section>
  );
}

function AdjustForm({
  label,
  unit,
  customerId,
  kind,
  currency,
}: {
  label: string;
  unit: string;
  customerId: string;
  kind: 'rewards' | 'tier-points';
  currency?: string;
}) {
  const { t } = useI18n();
  const command = useCustomerCommand();
  const recovery = useAdminOperationEntries().filter(isCustomerOperationEntry).find((entry) => entry.operation.scope === (kind === 'rewards' ? customerScope.rewards(customerId) : customerScope.tierPoints(customerId))) ?? null;
  const [amount, setAmount] = useState(() => kind === 'rewards' && recovery?.operation.kind === 'rewards' ? recovery.operation.draft.amount : kind === 'tier-points' && recovery?.operation.kind === 'tier-points' ? recovery.operation.draft.points : '');
  const [reason, setReason] = useState(() => kind === 'rewards' && recovery?.operation.kind === 'rewards' ? recovery.operation.draft.reason : kind === 'tier-points' && recovery?.operation.kind === 'tier-points' ? recovery.operation.draft.reason : '');
  /**
   * 這一份表單的冪等鍵。連點兩下、逾時重送都是同一把——這是會生出錢的操作，
   * 每次現產一把等於沒有保護。送出成功才換新的。
   */
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [adjustmentAttempt, setAdjustmentAttempt] = useState<{ amount: number; rawAmount: string; reason: string; rawReason: string; key: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const hadRecovery = useRef(Boolean(recovery));

  useEffect(() => {
    if (hadRecovery.current && !recovery && adjustmentAttempt) {
      setAdjustmentAttempt(null);
      setAmount(adjustmentAttempt.rawAmount);
      setReason(adjustmentAttempt.rawReason);
      setSubmissionKey(crypto.randomUUID());
    }
    hadRecovery.current = Boolean(recovery);
  }, [adjustmentAttempt, recovery]);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const attempt = adjustmentAttempt ?? { amount: Number(amount), rawAmount: amount, reason: reason.trim(), rawReason: reason, key: submissionKey };
    // 原因是必填：沒有原因的調整，事後查帳等於查不到。
    if (!Number.isInteger(attempt.amount) || attempt.amount === 0 || !attempt.reason) {
      setError(new Error(t('invalidAdjustment')));
      return;
    }
    if (!adjustmentAttempt) setAdjustmentAttempt(attempt);
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const operation = kind === 'rewards'
        ? { area: 'customer' as const, scope: customerScope.rewards(customerId), kind, customerId, request: { amountCents: attempt.amount, reason: attempt.reason }, draft: { amount, reason, currency: currency! }, idempotencyKey: attempt.key }
        : { area: 'customer' as const, scope: customerScope.tierPoints(customerId), kind, customerId, request: { points: attempt.amount, reason: attempt.reason }, draft: { points: amount, reason }, idempotencyKey: attempt.key };
      const result = await command(operation, recovery?.operation.kind === kind ? recovery : undefined);
      if (result.state === 'success') { setAdjustmentAttempt(null); setAmount(''); setReason(''); setSubmissionKey(crypto.randomUUID()); }
      else if (result.state === 'rejected') { setAdjustmentAttempt(null); setAmount(attempt.rawAmount); setReason(attempt.rawReason); setSubmissionKey(crypto.randomUUID()); setError(result.error); }
      else if (result.state === 'unknown') setError(result.error);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form className="adjust-form" onSubmit={submit}>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <label>{label}
        <input value={adjustmentAttempt?.rawAmount ?? amount} disabled={Boolean(adjustmentAttempt)} readOnly={!!recovery} onChange={(e) => setAmount(e.target.value)} placeholder={unit} />
      </label>
      <label>{t('reason')}
        <input value={adjustmentAttempt?.rawReason ?? reason} disabled={Boolean(adjustmentAttempt)} readOnly={!!recovery} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="button button--primary" type="submit" disabled={submitting || !!recovery}>{t('adjust')}</button>
    </form>
  );
}

function OrderRow({ order }: { order: AdminCustomerDetail['orders'][number] }) {
  const { formatMoney, formatDateTime } = useI18n();
  return (
    <tr>
      <td>{order.number}</td>
      <td><StatusBadge value={order.status} /></td>
      <td className="col-numeric">{formatMoney(order.totalCents, order.currency)}</td>
      <td className="mono">{formatDateTime(order.placedAt)}</td>
    </tr>
  );
}

/**
 * 生日決定生日禮券的發放資格，前台填完就鎖住——所以更正只能走這裡，
 * 而且要說得出為什麼：沒有理由的更正事後查不到帳。
 */
function BirthdayCorrection({ customerId }: { customerId: string }) {
  const { t } = useI18n();
  const command = useCustomerCommand();
  const recovery = useAdminOperationEntries().filter(isCustomerOperationEntry).find((entry) => entry.operation.scope === customerScope.profile(customerId)) ?? null;
  const [open, setOpen] = useState(false);
  const [birthday, setBirthday] = useState(() => recovery?.operation.kind === 'birthday' ? recovery.operation.draft.birthday : '');
  const [reason, setReason] = useState(() => recovery?.operation.kind === 'birthday' ? recovery.operation.draft.reason : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    // 日期由 <input type="date"> 保證是真的日曆日；這裡只確認有填。
    if (!birthday.trim() || !reason.trim()) {
      setError(new Error(t('invalidBirthdayCorrection')));
      return;
    }
    setSubmitting(true); setError(null);
    try {
      const request = { birthday: birthday.trim(), reason: reason.trim() };
      const result = await command({ area: 'customer', scope: customerScope.profile(customerId), kind: 'birthday', customerId, request, draft: { birthday, reason }, idempotencyKey: crypto.randomUUID() }, recovery?.operation.kind === 'birthday' ? recovery : undefined);
      if (result.state === 'success') { setOpen(false); setBirthday(''); setReason(''); }
      else if (result.state === 'rejected' || result.state === 'unknown') setError(result.error);
    } finally { setSubmitting(false); }
  };

  if (!open) return <button className="button button--quiet" type="button" onClick={() => setOpen(true)}><Icon name="pencil" /> {t('correctBirthday')}</button>;
  return <form className="birthday-correction-form" aria-label={t('correctBirthday')} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
    <p className="muted">{t('birthdayCorrectionHint')}</p>
    <div className="inline-form">
      <DateField
        id="corrected-birthday"
        label={t('correctedBirthday')}
        value={birthday}
        max={new Date().toISOString().slice(0, 10)}
        disabled={!!recovery}
        onChange={setBirthday}
      />
      <label>{t('correctionReason')}<input aria-label={t('correctionReason')} value={reason} readOnly={!!recovery} onChange={(event) => setReason(event.target.value)} /></label>
      <button className="button button--primary" disabled={submitting || !!recovery}>{t('submitCorrection')}</button>
      <button className="button" type="button" onClick={() => setOpen(false)}>{t('cancel')}</button>
    </div>
  </form>;
}
