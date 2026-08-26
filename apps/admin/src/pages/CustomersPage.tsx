import { useEffect, useState } from 'react';
import { api, type AdminCustomer, type AdminCustomerDetail, type CustomerLoyalty } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { DateField } from '../components/DateField';

export function CustomersPage() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listCustomers({ q: q || undefined, status: status || undefined, limit: 50 })
      .then((result) => {
        if (cancelled) return;
        setCustomers(result.items);
        setTotal(result.total);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [q, status, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <section>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

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

      {loading ? (
        <Loading />
      ) : customers.length === 0 ? (
        <EmptyState icon="user" title={t('noCustomers')} hint="顧客在前台完成註冊後就會出現在這裡。" />
      ) : (
        <div className="table-wrap"><table className="data-table data-table--fixed">
          <thead>
            <tr>
              <th style={{ width: '28%' }}>{t('email')}</th>
              <th style={{ width: '18%' }}>{t('name')}</th>
              <th style={{ width: '14%' }}>{t('phone')}</th>
              <th style={{ width: '14%' }}>{t('joinedAt')}</th>
              <th style={{ width: '12%' }}>{t('status')}</th>
              <th style={{ width: '14%' }} className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} onChanged={reload} />
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function CustomerRow({ customer, onChanged }: { customer: AdminCustomer; onChanged: () => void }) {
  const { t, formatDate } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<AdminCustomerDetail | null>(null);
  const [loyalty, setLoyalty] = useState<CustomerLoyalty | null>(null);
  const [loyaltyKey, setLoyaltyKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nextStatus = customer.status === 'active' ? 'disabled' : 'active';

  useEffect(() => {
    if (!expanded || detail) return;
    let cancelled = false;
    api.getCustomer(customer.id)
      .then((result) => !cancelled && setDetail(result))
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
  }, [expanded, detail, customer.id]);

  // 購物金與等級是另一個模組的資料，因此另外問一次；調整之後重新載入。
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api.customerLoyalty(customer.id)
      .then((result) => !cancelled && setLoyalty(result))
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
  }, [expanded, customer.id, loyaltyKey]);

  const toggleStatus = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.setCustomerStatus(customer.id, nextStatus);
      onChanged();
    } catch (err) {
      setError(err);
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
            disabled={submitting}
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
              {!detail ? <Loading /> : (
                <div className="detail-cards">
                  <section className="detail-card">
                    <div className="detail-card__header">
                      <h4>{t('profile')}</h4>
                      <BirthdayCorrection customerId={customer.id} onCorrected={() => setDetail(null)} />
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

                  <LoyaltyPanel
                    customerId={customer.id}
                    loyalty={loyalty}
                    onAdjusted={() => setLoyaltyKey((k) => k + 1)}
                  />

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
              )}
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
function LoyaltyPanel({
  customerId,
  loyalty,
  onAdjusted,
}: {
  customerId: string;
  loyalty: CustomerLoyalty | null;
  onAdjusted: () => void;
}) {
  const { t, formatMoney, formatDateTime } = useI18n();
  if (!loyalty) return <section className="detail-card"><Loading /></section>;

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
          onSubmit={(amount, reason, key) => api.adjustRewards(customerId, { amountCents: amount, reason }, key)}
          onDone={onAdjusted}
        />
        <AdjustForm
          label={t('adjustTierPoints')}
          unit={t('tierPointUnit')}
          onSubmit={(points, reason, key) => api.adjustTierPoints(customerId, { points, reason }, key)}
          onDone={onAdjusted}
        />
      </div>
    </section>
  );
}

function AdjustForm({
  label,
  unit,
  onSubmit,
  onDone,
}: {
  label: string;
  unit: string;
  onSubmit: (amount: number, reason: string, idempotencyKey: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  /**
   * 這一份表單的冪等鍵。連點兩下、逾時重送都是同一把——這是會生出錢的操作，
   * 每次現產一把等於沒有保護。送出成功才換新的。
   */
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const value = Number(amount);
    // 原因是必填：沒有原因的調整，事後查帳等於查不到。
    if (!Number.isInteger(value) || value === 0 || !reason.trim()) {
      setError(new Error(t('invalidAdjustment')));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(value, reason.trim(), submissionKey);
      setAmount('');
      setReason('');
      setSubmissionKey(crypto.randomUUID());
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="adjust-form" onSubmit={submit}>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <label>{label}
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={unit} />
      </label>
      <label>{t('reason')}
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="button button--primary" type="submit" disabled={submitting}>{t('adjust')}</button>
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
function BirthdayCorrection({ customerId, onCorrected }: { customerId: string; onCorrected: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [birthday, setBirthday] = useState('');
  const [reason, setReason] = useState('');
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
      await api.correctCustomerBirthday(customerId, { birthday: birthday.trim(), reason: reason.trim() });
      setOpen(false); setBirthday(''); setReason('');
      onCorrected();
    } catch (err) { setError(err); } finally { setSubmitting(false); }
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
        onChange={setBirthday}
      />
      <label>{t('correctionReason')}<input aria-label={t('correctionReason')} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <button className="button button--primary" disabled={submitting}>{t('submitCorrection')}</button>
      <button className="button" type="button" onClick={() => setOpen(false)}>{t('cancel')}</button>
    </div>
  </form>;
}
