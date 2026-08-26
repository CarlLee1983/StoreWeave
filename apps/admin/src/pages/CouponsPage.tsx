import { useEffect, useState } from 'react';
import { api, type Coupon, type IssueResult, type Promotion } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { DateTimeField } from '../components/DateTimeField';
import { useEscapeKey } from '../hooks/useEscapeKey';

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
  const [creating, setCreating] = useState(false);
  const [issuing, setIssuing] = useState(false);
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

  // 頁首那顆「建立券」由 routes 宣告，預設只捲到 targetId；
  // 這裡攔下同名事件改開抽屜，preventDefault 等於告訴 App「這頁自己處理了」。
  useEffect(() => {
    const openCreate = (event: Event) => {
      event.preventDefault();
      setCreating(true);
    };
    window.addEventListener('admin:action:create-coupon', openCreate);
    return () => window.removeEventListener('admin:action:create-coupon', openCreate);
  }, []);

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
        <button type="button" className="button button--primary" onClick={() => setIssuing(true)}>
          <Icon name="send" /> {t('issueCoupons')}
        </button>
      </div>

      {loading ? (
        <Loading />
      ) : coupons.length === 0 ? (
        <EmptyState icon="ticket" title={t('noCoupons')} hint="建立折扣碼之後，這裡會列出它的使用狀況與有效期間。" />
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table--fixed">
            <thead>
              <tr>
                <th style={{ width: '10%' }}>{t('couponCode')}</th>
                <th style={{ width: '13%' }}>{t('couponKind')}</th>
                <th style={{ width: '22%' }}>{t('promotionName')}</th>
                <th style={{ width: '17%' }}>{t('period')}</th>
                <th style={{ width: '10%' }} className="col-numeric">{t('couponUsage')}</th>
                <th style={{ width: '10%' }}>{t('status')}</th>
                <th style={{ width: '18%' }} className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((coupon) => (
                <CouponRow key={coupon.id} coupon={coupon} promotionName={promotionName(coupon.promotionId)} onChanged={reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateCouponDrawer
          promotions={couponPromotions(promotions)}
          onClose={() => setCreating(false)}
          onCreated={reload}
        />
      ) : null}

      {issuing ? (
        <IssueCouponsDrawer
          promotions={couponPromotions(promotions)}
          onClose={() => setIssuing(false)}
          onIssued={reload}
        />
      ) : null}
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
      <td><span className="cell-truncate" title={promotionName}>{promotionName}</span></td>
      <td className="mono">
        {coupon.startsAt ? formatDateTime(coupon.startsAt) : '—'} → {coupon.endsAt ? formatDateTime(coupon.endsAt) : '—'}
      </td>
      {/* 已用 / 上限。不限量時只說用了幾次——「3 / ∞」讀起來像是壞掉的畫面 */}
      <td className="col-numeric">
        {coupon.maxRedemptions === null ? coupon.redeemedCount : `${coupon.redeemedCount} / ${coupon.maxRedemptions}`}
      </td>
      <td><StatusBadge value={coupon.status === 'void' ? 'disabled' : coupon.status === 'used' ? 'paid' : 'running'} /></td>
      <td className="col-actions">
        <button type="button" className="button button--quiet" onClick={toggle} disabled={submitting}>
          <Icon name={coupon.status === 'void' ? 'play' : 'pause'} /> {coupon.status === 'void' ? t('enable') : t('disable')}
        </button>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}

/** 建立券抽屜：版型比照 ProductsPage 的 CreateProductDrawer，常駐表單會把清單擠到摺線以下。 */
function CreateCouponDrawer({
  promotions,
  onClose,
  onCreated,
}: {
  promotions: Promotion[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [promotionId, setPromotionId] = useState('');
  const [partnerCode, setPartnerCode] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [perCustomerOnce, setPerCustomerOnce] = useState(true);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEscapeKey(onClose);

  const submit = async () => {
    const trimmed = code.trim();
    const max = maxRedemptions.trim() === '' ? undefined : Number(maxRedemptions);
    if (!trimmed || !promotionId || (max !== undefined && (!Number.isInteger(max) || max <= 0))) {
      setError(new Error(t('invalidCoupon')));
      return;
    }
    // 後端也會擋，但先在這裡說清楚：送出去再被退回，使用者得自己猜是哪一個欄位錯。
    if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setError(new Error(t('invalidPeriod')));
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
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="payload-drawer product-edit-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('createCoupon')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="product-drawer-header">
          <div>
            <h2>{t('createCoupon')}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </button>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={t('createCoupon')}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

          <div className="drawer-form-body">
            <div className="form-field">
              <label htmlFor="create-coupon-code">
                <span className="field-label-text">{t('couponCode')}</span>
              </label>
              <input
                id="create-coupon-code"
                aria-label={t('couponCode')}
                className="mono"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="SUMMER20"
              />
            </div>

            <div className="form-field">
              <label htmlFor="create-coupon-promotion">
                <span className="field-label-text">{t('promotionName')}</span>
              </label>
              <select
                id="create-coupon-promotion"
                aria-label={t('promotionName')}
                value={promotionId}
                onChange={(e) => setPromotionId(e.target.value)}
              >
                <option value="">{t('selectPromotion')}</option>
                {promotions.map((promotion) => (
                  <option key={promotion.id} value={promotion.id}>{promotion.name}</option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="create-coupon-partner">
                <span className="field-label-text">{t('partnerCode')}</span>
              </label>
              <input
                id="create-coupon-partner"
                aria-label={t('partnerCode')}
                value={partnerCode}
                onChange={(e) => setPartnerCode(e.target.value)}
                placeholder={t('partnerCodeHint')}
              />
            </div>

            <div className="form-field">
              <label htmlFor="create-coupon-max-redemptions">
                <span className="field-label-text">{t('maxRedemptions')}</span>
              </label>
              <input
                id="create-coupon-max-redemptions"
                aria-label={t('maxRedemptions')}
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
                inputMode="numeric"
              />
            </div>

            {/* 檔期是一組：開始與結束各佔一列，兩邊的日期與時間欄寬才對得齊。 */}
            <DateTimeField
              id="create-coupon-starts-at"
              label={t('startsAt')}
              value={startsAt}
              hint={t('couponStartsAtHint')}
              onChange={setStartsAt}
            />

            <DateTimeField
              id="create-coupon-ends-at"
              label={t('endsAt')}
              value={endsAt}
              onChange={setEndsAt}
            />

            <label className="checkbox">
              <input type="checkbox" checked={perCustomerOnce} onChange={(e) => setPerCustomerOnce(e.target.checked)} />
              {t('perCustomerOnce')}
            </label>
          </div>

          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="button button--primary" disabled={submitting}>
              {submitting ? '建立中…' : t('create')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

/** 批次發券抽屜：由工具列自己的按鈕開啟，與建立券互不影響。 */
function IssueCouponsDrawer({
  promotions,
  onClose,
  onIssued,
}: {
  promotions: Promotion[];
  onClose: () => void;
  onIssued: () => void;
}) {
  const { t } = useI18n();
  const [promotionId, setPromotionId] = useState('');
  const [codePrefix, setCodePrefix] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('30');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<IssueResult | null>(null);

  useEscapeKey(onClose);

  const submit = async () => {
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
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="payload-drawer product-edit-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('issueCoupons')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="product-drawer-header">
          <div>
            <h2>{t('issueCoupons')}</h2>
            <p className="product-drawer-sku">{t('issueCouponsHint')}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('close')} title={t('close')}>
            <Icon name="chevron" />
          </button>
        </header>

        <form
          className="form-panel product-drawer-form"
          aria-label={t('issueCoupons')}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
          {result ? <p role="status">{t('issueResult')}: {result.issued}（{t('skipped')}: {result.skipped}）</p> : null}

          <div className="drawer-form-body">
            <div className="form-field">
              <label htmlFor="issue-coupon-promotion">
                <span className="field-label-text">{t('promotionName')}</span>
              </label>
              <select
                id="issue-coupon-promotion"
                aria-label={t('issuePromotion')}
                value={promotionId}
                onChange={(e) => setPromotionId(e.target.value)}
              >
                <option value="">{t('selectPromotion')}</option>
                {promotions.map((promotion) => (
                  <option key={promotion.id} value={promotion.id}>{promotion.name}</option>
                ))}
              </select>
            </div>

            <div className="form-grid-2">
              <div className="form-field">
                <label htmlFor="issue-coupon-prefix">
                  <span className="field-label-text">{t('codePrefix')}</span>
                </label>
                <input
                  id="issue-coupon-prefix"
                  aria-label={t('codePrefix')}
                  value={codePrefix}
                  onChange={(e) => setCodePrefix(e.target.value.toUpperCase())}
                  placeholder="VIP"
                />
              </div>

              <div className="form-field">
                <label htmlFor="issue-coupon-expires">
                  <span className="field-label-text">{t('expiresInDays')}</span>
                </label>
                <input
                  id="issue-coupon-expires"
                  aria-label={t('expiresInDays')}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </div>
          </div>

          <footer className="product-drawer-footer">
            <button className="button" type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="button button--primary" disabled={submitting}>
              {submitting ? '發放中…' : t('issue')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
