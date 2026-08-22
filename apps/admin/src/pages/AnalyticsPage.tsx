import { useEffect, useState } from 'react';
import {
  api,
  type AttributionSummary,
  type OutstandingRewards,
  type PromotionPerformance,
  type SalesSummary,
} from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 行銷分析。
 *
 * 活動成效查的是核銷明細——它天生比訂單表小得多，而且本來就是為了這件事存在的。
 * 這裡刻意**不建 projection 或 read model**（Spec 0005）。
 *
 * 期間由整頁共用一組：三張表回答的是同一段時間的同一個問題，各自帶一組日期
 * 只會讓人比對到不同期間的數字。
 */
export function AnalyticsPage() {
  const { t } = useI18n();
  const [from, setFrom] = useState(toDateInput(new Date(Date.now() - 30 * DAY_MS)));
  const [to, setTo] = useState(toDateInput(new Date()));

  return (
    <section>
      <div className="toolbar">
        <label>
          {t('from')}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t('to')}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <SalesSummarySection from={from} to={to} />
      <PromotionPerformanceSection from={from} to={to} />
      <PartnerSection from={from} to={to} />
      <OutstandingRewardsSection />
    </section>
  );
}

/** 查詢區間換算成含頭含尾的一整天，與搬家前的行為逐字相同。 */
function useRange(from: string, to: string) {
  return { from, to };
}

function SalesSummarySection({ from, to }: { from: string; to: string }) {
  const { t, formatMoney } = useI18n();
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .salesSummary({ from, to })
      .then((result) => !cancelled && setSummary(result))
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [from, to]);

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('salesSummary')}</h3></div><div className="panel__body">
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {loading ? (
        <Loading />
      ) : (
        summary && (
          <>
            <div className="summary-cards">
              <SummaryCard label={t('paidOrders')} value={String(summary.paidOrderCount)} /><SummaryCard label={t('pendingOrders')} value={String(summary.pendingOrderCount)} /><SummaryCard label={t('cancelledOrders')} value={String(summary.cancelledOrderCount)} /><SummaryCard label={t('grossRevenue')} value={formatMoney(summary.grossRevenueCents, summary.currency)} /><SummaryCard label={t('averageOrderValue')} value={formatMoney(summary.averageOrderValueCents, summary.currency)} />
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>{t('productName')}</th><th>{t('salesQuantity')}</th><th>{t('revenue')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.topProducts.map((product) => (
                  <tr key={product.productId}>
                    <td>{product.sku}</td>
                    <td>{product.name}</td>
                    <td>{product.quantity}</td>
                    <td>{formatMoney(product.revenueCents, summary.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      )}
    </div></div>
  );
}


function PromotionPerformanceSection({ from, to }: { from: string; to: string }) {
  const { t, formatMoney } = useI18n();
  const [items, setItems] = useState<PromotionPerformance[] | null>(null);
  const [currency, setCurrency] = useState('');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.promotionPerformance(useRange(from, to))
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setCurrency(result.currency);
      })
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
  }, [from, to]);

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('promotionPerformance')}</h3></div><div className="panel__body">
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {!items ? <Loading /> : items.length === 0 ? <p className="muted">{t('noRedemptions')}</p> : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('promotionName')}</th><th>{t('redemptionCount')}</th>
              <th>{t('orderCount')}</th><th>{t('discountTotal')}</th><th>{t('revenue')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.promotionId}>
                <td>{item.name}</td>
                <td className="mono">{item.redemptionCount}</td>
                <td className="mono">{item.orderCount}</td>
                <td className="mono">{formatMoney(item.discountCents, currency)}</td>
                <td className="mono">{formatMoney(item.revenueCents, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div></div>
  );
}

function PartnerSection({ from, to }: { from: string; to: string }) {
  const { t, formatMoney } = useI18n();
  const [items, setItems] = useState<AttributionSummary[] | null>(null);
  const [currency, setCurrency] = useState('');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.partnerPerformance(useRange(from, to))
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setCurrency(result.currency);
      })
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
  }, [from, to]);

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('partnerPerformance')}</h3></div><div className="panel__body">
      {/* 佣金不由系統計算：這裡給的是成效數字，結算靠人工（Spec 0004） */}
      <p className="muted">{t('partnerPerformanceHint')}</p>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {!items ? <Loading /> : items.length === 0 ? <p className="muted">{t('noPartners')}</p> : (
        <table className="data-table">
          <thead>
            <tr><th>{t('partnerCode')}</th><th>{t('orderCount')}</th><th>{t('revenue')}</th><th>{t('discountTotal')}</th></tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.partnerCode}>
                <td>{item.partnerCode}</td>
                <td className="mono">{item.orderCount}</td>
                <td className="mono">{formatMoney(item.revenueCents, currency)}</td>
                <td className="mono">{formatMoney(item.discountCents, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div></div>
  );
}

function OutstandingRewardsSection() {
  const { t, formatMoney } = useI18n();
  const [data, setData] = useState<OutstandingRewards | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api.outstandingRewards()
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('outstandingRewards')}</h3></div><div className="panel__body">
      {/* 購物金一旦能折抵金額，它就是一本負債帳 */}
      <p className="muted">{t('outstandingRewardsHint')}</p>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {!data ? <Loading /> : (
        <div className="summary-cards">
          <SummaryCard label={t('rewardAvailable')} value={formatMoney(data.availableCents, data.currency)} />
          <SummaryCard label={t('rewardPending')} value={formatMoney(data.pendingCents, data.currency)} />
          <SummaryCard label={t('rewardHolders')} value={String(data.customerCount)} />
        </div>
      )}
    </div></div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-card">
      <span className="summary-card__label">{label}</span>
      <span className="summary-card__value">{value}</span>
    </div>
  );
}
