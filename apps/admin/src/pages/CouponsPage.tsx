import { useEffect, useState } from 'react';
import { api, type Coupon, type IssueResult, type Promotion } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

/**
 * 券的清單與管理。
 *
 * 券的「型別」不是欄位，而是兩個事實的組合：有沒有擁有者（共用碼／實發券）、
 * 有沒有合作夥伴（行銷碼）。這裡把它算出來顯示，而不是逼經營者去讀欄位。
 */
function couponKind(coupon: Coupon): 'sharedCode' | 'issuedCoupon' | 'marketingCode' {
  if (coupon.partnerCode) return 'marketingCode';
  return coupon.customerId ? 'issuedCoupon' : 'sharedCode';
}

/** 券要指向一條「需要券」的活動；人人適用的活動配上券沒有意義。 */
function couponPromotions(promotions: Promotion[]): Promotion[] {
  return promotions.filter((promotion) => promotion.requiresCoupon);
}

export function CouponsPage() {
  const { t } = useI18n();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const limit = 100;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api.listCoupons({ status: status || undefined, limit }),
      api.listPromotions({ limit }),
    ])
      .then(([couponResult, promotionResult]) => {
        if (cancelled) return;
        setCoupons(couponResult.items);
        setTotal(couponResult.total);
        setPromotions(promotionResult.items);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [status, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const promotionName = (id: string) => promotions.find((p) => p.id === id)?.name ?? id;

  return (
    <section>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('allStatuses')}</option>
          <option value="issued">{t('couponIssued')}</option>
          <option value="used">{t('couponUsed')}</option>
          <option value="void">{t('disabled')}</option>
        </select>
        {/* 超出一頁時要說出來，不然第 101 張券在後台就是憑空消失 */}
        {total > coupons.length ? <span>{`${coupons.length} / ${total}`}</span> : null}
      </div>

      <CreateCouponForm promotions={couponPromotions(promotions)} onCreated={reload} />
      <IssueCouponsForm promotions={couponPromotions(promotions)} onIssued={reload} />

      {loading ? (
        <Loading />
      ) : coupons.length === 0 ? (
        <p>{t('noCoupons')}</p>
      ) : (
        <div className="table-wrap"><table className="data-table">
          <thead>
            <tr>
              <th>{t('couponCode')}</th><th>{t('couponKind')}</th><th>{t('promotionName')}</th>
              <th>{t('period')}</th><th>{t('couponUsage')}</th><th>{t('status')}</th><th />
            </tr>
          </thead>
          <tbody>
            {coupons.map((coupon) => (
              <CouponRow key={coupon.id} coupon={coupon} promotionName={promotionName(coupon.promotionId)} onChanged={reload} />
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function CouponRow({
  coupon,
  promotionName,
  onChanged,
}: {
  coupon: Coupon;
  promotionName: string;
  onChanged: () => void;
}) {
  const { t, formatDateTime } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nextStatus = coupon.status === 'void' ? 'issued' : 'void';

  const toggle = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.setCouponStatus(coupon.id, nextStatus);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <tr>
      <td className="mono">{coupon.code}</td>
      <td>{t(couponKind(coupon))}{coupon.partnerCode ? ` · ${coupon.partnerCode}` : ''}</td>
      <td>{promotionName}</td>
      <td className="mono">
        {coupon.startsAt ? formatDateTime(coupon.startsAt) : '—'} → {coupon.endsAt ? formatDateTime(coupon.endsAt) : '—'}
      </td>
      {/* 已用 / 上限。不限量時只說用了幾次——「3 / ∞」讀起來像是壞掉的畫面 */}
      <td className="mono">
        {coupon.maxRedemptions === null ? coupon.redeemedCount : `${coupon.redeemedCount} / ${coupon.maxRedemptions}`}
      </td>
      <td><StatusBadge value={coupon.status === 'void' ? 'disabled' : coupon.status === 'used' ? 'paid' : 'running'} /></td>
      <td>
        <div className="inline-form">
          <button type="button" onClick={toggle} disabled={submitting}>
            {coupon.status === 'void' ? t('enable') : t('disable')}
          </button>
        </div>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}

function CreateCouponForm({ promotions, onCreated }: { promotions: Promotion[]; onCreated: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [promotionId, setPromotionId] = useState('');
  const [partnerCode, setPartnerCode] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [perCustomerOnce, setPerCustomerOnce] = useState(true);
  const [endsAt, setEndsAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const trimmed = code.trim();
    const max = maxRedemptions.trim() === '' ? undefined : Number(maxRedemptions);
    if (!trimmed || !promotionId || (max !== undefined && (!Number.isInteger(max) || max <= 0))) {
      setError(new Error(t('invalidCoupon')));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.createCoupon({
        code: trimmed,
        promotionId,
        partnerCode: partnerCode.trim() || undefined,
        maxRedemptions: max,
        perCustomerLimit: perCustomerOnce ? 1 : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
      });
      setCode('');
      setPartnerCode('');
      setMaxRedemptions('');
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="panel" id="create-coupon" onSubmit={submit}>
      <h3>{t('createCoupon')}</h3>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <div className="form-grid">
        <label>{t('couponCode')}
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="SUMMER20" />
        </label>
        <label>{t('promotionName')}
          <select value={promotionId} onChange={(e) => setPromotionId(e.target.value)}>
            <option value="">{t('selectPromotion')}</option>
            {promotions.map((promotion) => (
              <option key={promotion.id} value={promotion.id}>{promotion.name}</option>
            ))}
          </select>
        </label>
        <label>{t('partnerCode')}
          <input value={partnerCode} onChange={(e) => setPartnerCode(e.target.value)} placeholder={t('partnerCodeHint')} />
        </label>
        <label>{t('maxRedemptions')}
          <input value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} inputMode="numeric" />
        </label>
        <label>{t('endsAt')}
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={perCustomerOnce} onChange={(e) => setPerCustomerOnce(e.target.checked)} />
          {t('perCustomerOnce')}
        </label>
      </div>
      <button type="submit" disabled={submitting}>{t('create')}</button>
    </form>
  );
}

function IssueCouponsForm({ promotions, onIssued }: { promotions: Promotion[]; onIssued: () => void }) {
  const { t } = useI18n();
  const [promotionId, setPromotionId] = useState('');
  const [codePrefix, setCodePrefix] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('30');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<IssueResult | null>(null);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const days = expiresInDays.trim() === '' ? undefined : Number(expiresInDays);
    if (!promotionId || (days !== undefined && (!Number.isInteger(days) || days <= 0))) {
      setError(new Error(t('invalidIssue')));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // 發放結果要看得見：經營者按下去之後，「發了幾張」是他唯一在意的事。
      setResult(await api.issueCoupons({
        promotionId,
        codePrefix: codePrefix.trim() || undefined,
        expiresInDays: days,
      }));
      onIssued();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="panel" id="issue-coupons" onSubmit={submit}>
      <h3>{t('issueCoupons')}</h3>
      <p className="muted">{t('issueCouponsHint')}</p>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {result ? <p role="status">{t('issueResult')}: {result.issued}（{t('skipped')}: {result.skipped}）</p> : null}
      <div className="form-grid">
        <label>{t('promotionName')}
          <select value={promotionId} onChange={(e) => setPromotionId(e.target.value)} aria-label={t('issuePromotion')}>
            <option value="">{t('selectPromotion')}</option>
            {promotions.map((promotion) => (
              <option key={promotion.id} value={promotion.id}>{promotion.name}</option>
            ))}
          </select>
        </label>
        <label>{t('codePrefix')}
          <input value={codePrefix} onChange={(e) => setCodePrefix(e.target.value.toUpperCase())} placeholder="VIP" />
        </label>
        <label>{t('expiresInDays')}
          <input value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <button type="submit" disabled={submitting}>{t('issue')}</button>
    </form>
  );
}
