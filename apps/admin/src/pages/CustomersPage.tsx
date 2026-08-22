import { useEffect, useState } from 'react';
import { api, type AdminCustomer, type AdminCustomerDetail, type CustomerLoyalty } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

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
        <input aria-label={t('searchCustomers')} placeholder={t('searchCustomers')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('allStatuses')}</option>
          <option value="active">{t('active')}</option>
          <option value="disabled">{t('disabled')}</option>
        </select>
        {total > customers.length ? <span>{`${customers.length} / ${total}`}</span> : null}
      </div>

      {loading ? (
        <Loading />
      ) : customers.length === 0 ? (
        <p>{t('noCustomers')}</p>
      ) : (
        <div className="table-wrap"><table className="data-table">
          <thead>
            <tr>
              <th>{t('email')}</th><th>{t('name')}</th><th>{t('phone')}</th>
              <th>{t('joinedAt')}</th><th>{t('status')}</th><th />
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
  const { t, formatDateTime } = useI18n();
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
        <td>{customer.email}</td>
        <td>{customer.displayName}</td>
        <td className="mono">{customer.phone ?? '—'}</td>
        <td className="mono">{formatDateTime(customer.createdAt)}</td>
        <td><StatusBadge value={customer.status === 'active' ? 'active' : 'disabled'} /></td>
        <td>
          <button
            type="button"
            disabled={submitting}
            onClick={(e) => {
              e.stopPropagation();
              void toggleStatus();
            }}
          >
            {customer.status === 'active' ? t('disable') : t('enable')}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <div className="order-detail">
              {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
              {!detail ? <Loading /> : (
                <>
                  <dl className="order-totals">
                    <dt>{t('birthday')}</dt><dd>{detail.birthday ?? '—'}</dd>
                    <dt>{t('phone')}</dt><dd className="mono">{detail.phone ?? '—'}</dd>
                    <dt>{t('address')}</dt>
                    <dd>{detail.address ? `${detail.address.postcode} ${detail.address.city} ${detail.address.line1} ${detail.address.line2 ?? ''}` : '—'}</dd>
                  </dl>
                  <LoyaltyPanel
                    customerId={customer.id}
                    loyalty={loyalty}
                    onAdjusted={() => setLoyaltyKey((k) => k + 1)}
                  />
                  <h4>{t('orderHistory')}</h4>
                  {detail.orders.length === 0 ? <p className="muted">{t('noOrders')}</p> : (
                    <table className="data-table data-table--nested">
                      <thead>
                        <tr><th>{t('orderNumber')}</th><th>{t('status')}</th><th>{t('total')}</th><th>{t('orderedAt')}</th></tr>
                      </thead>
                      <tbody>
                        {detail.orders.map((order) => (
                          <OrderRow key={order.id} order={order} />
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
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
  if (!loyalty) return <Loading />;

  return (
    <>
      <h4>{t('loyalty')}</h4>
      <dl className="order-totals">
        <dt>{t('rewardAvailable')}</dt><dd className="mono">{formatMoney(loyalty.balance.availableCents, 'TWD')}</dd>
        <dt>{t('rewardPending')}</dt><dd className="mono">{formatMoney(loyalty.balance.pendingCents, 'TWD')}</dd>
        <dt>{t('nextExpiry')}</dt>
        <dd className="mono">
          {loyalty.balance.nextExpiry
            ? `${formatMoney(loyalty.balance.nextExpiry.amountCents, 'TWD')} · ${formatDateTime(loyalty.balance.nextExpiry.expiresAt)}`
            : '—'}
        </dd>
        <dt>{t('memberTier')}</dt><dd>{loyalty.tierName}（{loyalty.tierPoints}）</dd>
      </dl>
      <div className="inline-form">
        <AdjustForm
          label={t('adjustRewards')}
          unit={t('rewardUnit')}
          onSubmit={(amount, reason) => api.adjustRewards(customerId, { amountCents: amount, reason })}
          onDone={onAdjusted}
        />
        <AdjustForm
          label={t('adjustTierPoints')}
          unit={t('tierPointUnit')}
          onSubmit={(points, reason) => api.adjustTierPoints(customerId, { points, reason })}
          onDone={onAdjusted}
        />
      </div>
    </>
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
  onSubmit: (amount: number, reason: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
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
      await onSubmit(value, reason.trim());
      setAmount('');
      setReason('');
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <label>{label}
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={unit} />
      </label>
      <label>{t('reason')}
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="submit" disabled={submitting}>{t('adjust')}</button>
    </form>
  );
}

function OrderRow({ order }: { order: AdminCustomerDetail['orders'][number] }) {
  const { formatMoney, formatDateTime } = useI18n();
  return (
    <tr>
      <td>{order.number}</td>
      <td><StatusBadge value={order.status} /></td>
      <td className="mono">{formatMoney(order.totalCents, order.currency)}</td>
      <td className="mono">{formatDateTime(order.placedAt)}</td>
    </tr>
  );
}
