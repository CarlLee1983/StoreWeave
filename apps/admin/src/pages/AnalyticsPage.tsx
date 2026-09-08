import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { DateField } from '../components/DateField';
import { EmptyState } from '../components/EmptyState';
import { analyticsKeys } from '../query';

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
        {/* 區間不接受反向：把一邊拖過另一邊時，另一邊跟著移動，
            而不是送出一段查不到東西的負區間。 */}
        <DateField
          id="analytics-from"
          label={t('from')}
          value={from}
          max={to}
          onChange={(next) => {
            setFrom(next);
            if (next && to && next > to) setTo(next);
          }}
        />
        <DateField
          id="analytics-to"
          label={t('to')}
          value={to}
          min={from}
          onChange={(next) => {
            setTo(next);
            if (next && from && next < from) setFrom(next);
          }}
        />
      </div>
      <SalesSummarySection from={from} to={to} />
      <PromotionPerformanceSection from={from} to={to} />
      <PartnerSection from={from} to={to} />
      <OutstandingRewardsSection />
    </section>
  );
}

function SalesSummarySection({ from, to }: { from: string; to: string }) {
  const { t, formatMoney } = useI18n();
  const query = useQuery({ queryKey: analyticsKeys.salesSummary({ from, to }), queryFn: ({ signal }) => api.salesSummary({ from, to }, signal) });
  const summary = query.data;

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('salesSummary')}</h3></div><div className="panel__body">
      {query.isError ? <ErrorBanner error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isLoading ? (
        <Loading />
      ) : (
        summary && (
          <>
            <div className="summary-cards">
              <SummaryCard label={t('paidOrders')} value={String(summary.paidOrderCount)} /><SummaryCard label={t('pendingOrders')} value={String(summary.pendingOrderCount)} /><SummaryCard label={t('cancelledOrders')} value={String(summary.cancelledOrderCount)} /><SummaryCard label={t('grossRevenue')} value={formatMoney(summary.grossRevenueCents, summary.currency)} /><SummaryCard label={t('averageOrderValue')} value={formatMoney(summary.averageOrderValueCents, summary.currency)} />
            </div>
            {summary.topProducts.length === 0 ? <EmptyState title={t('noTopProducts')} /> : <div className="table-wrap"><table className="data-table data-table--fixed analytics-table">
              <thead>
                <tr>
                  <th style={{ width: '16%' }}>{t('sku')}</th>
                  <th style={{ width: '40%' }}>{t('productName')}</th>
                  <th style={{ width: '20%' }} className="col-numeric">{t('salesQuantity')}</th>
                  <th style={{ width: '24%' }} className="col-numeric">{t('revenue')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.topProducts.map((product) => (
                  <tr key={product.productId}>
                    <td>{product.sku}</td>
                    <td>{product.name}</td>
                    <td className="col-numeric">{product.quantity}</td>
                    <td className="col-numeric">{formatMoney(product.revenueCents, summary.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>}
          </>
        )
      )}
    </div></div>
  );
}


function PromotionPerformanceSection({ from, to }: { from: string; to: string }) {
  const { t, formatMoney } = useI18n();
  const query = useQuery({ queryKey: analyticsKeys.promotionPerformance({ from, to }), queryFn: ({ signal }) => api.promotionPerformance({ from, to }, signal) });
  const items = query.data?.items;
  const currency = query.data?.currency ?? '';

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('promotionPerformance')}</h3></div><div className="panel__body">
      {query.isError ? <ErrorBanner error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isLoading ? <Loading /> : items?.length === 0 ? <p className="muted">{t('noRedemptions')}</p> : items ? (
        <div className="table-wrap"><table className="data-table data-table--fixed analytics-table">
          <thead>
            <tr>
              <th style={{ width: '28%' }}>{t('promotionName')}</th>
              <th style={{ width: '16%' }} className="col-numeric">{t('redemptionCount')}</th>
              <th style={{ width: '16%' }} className="col-numeric">{t('orderCount')}</th>
              <th style={{ width: '20%' }} className="col-numeric">{t('discountTotal')}</th>
              <th style={{ width: '20%' }} className="col-numeric">{t('revenue')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.promotionId}>
                <td><span className="cell-truncate" title={item.name}>{item.name}</span></td>
                <td className="col-numeric">{item.redemptionCount}</td>
                <td className="col-numeric">{item.orderCount}</td>
                <td className="col-numeric">{formatMoney(item.discountCents, currency)}</td>
                <td className="col-numeric">{formatMoney(item.revenueCents, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
    </div></div>
  );
}

function PartnerSection({ from, to }: { from: string; to: string }) {
  const { t, formatMoney } = useI18n();
  const query = useQuery({ queryKey: analyticsKeys.partnerPerformance({ from, to }), queryFn: ({ signal }) => api.partnerPerformance({ from, to }, signal) });
  const items = query.data?.items;
  const currency = query.data?.currency ?? '';

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('partnerPerformance')}</h3></div><div className="panel__body">
      {/* 佣金不由系統計算：這裡給的是成效數字，結算靠人工（Spec 0004） */}
      <p className="muted">{t('partnerPerformanceHint')}</p>
      {query.isError ? <ErrorBanner error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isLoading ? <Loading /> : items?.length === 0 ? <p className="muted">{t('noPartners')}</p> : items ? (
        <div className="table-wrap"><table className="data-table data-table--fixed analytics-table">
          <thead>
            <tr>
              <th style={{ width: '28%' }}>{t('partnerCode')}</th>
              <th style={{ width: '20%' }} className="col-numeric">{t('orderCount')}</th>
              <th style={{ width: '26%' }} className="col-numeric">{t('revenue')}</th>
              <th style={{ width: '26%' }} className="col-numeric">{t('discountTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.partnerCode}>
                <td>{item.partnerCode}</td>
                <td className="col-numeric">{item.orderCount}</td>
                <td className="col-numeric">{formatMoney(item.revenueCents, currency)}</td>
                <td className="col-numeric">{formatMoney(item.discountCents, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
    </div></div>
  );
}

function OutstandingRewardsSection() {
  const { t, formatMoney } = useI18n();
  const query = useQuery({ queryKey: analyticsKeys.outstandingRewards, queryFn: ({ signal }) => api.outstandingRewards(signal) });
  const data = query.data;

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('outstandingRewards')}</h3></div><div className="panel__body">
      {/* 購物金一旦能折抵金額，它就是一本負債帳 */}
      <p className="muted">{t('outstandingRewardsHint')}</p>
      {query.isError ? <ErrorBanner error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isLoading ? <Loading /> : data ? (
        <div className="summary-cards">
          <SummaryCard label={t('rewardAvailable')} value={formatMoney(data.availableCents, data.currency)} />
          <SummaryCard label={t('rewardPending')} value={formatMoney(data.pendingCents, data.currency)} />
          <SummaryCard label={t('rewardHolders')} value={String(data.customerCount)} />
        </div>
      ) : null}
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
