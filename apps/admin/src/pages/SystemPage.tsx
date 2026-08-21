import { useEffect, useState } from 'react';
import { api, type ExtensionInfo, type HealthReport, type SalesSummary } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function SystemPage() {
  return (
    <section>
      <HealthSection />
      <ExtensionsSection />
      <SalesSummarySection />
    </section>
  );
}

function HealthSection() {
  const { t } = useI18n();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .healthDependencies()
      .then(setReport)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('dependencyHealth')}</h3></div><div className="panel__body">
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {loading ? (
        <Loading />
      ) : (
        report && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('name')}</th><th>{t('status')}</th><th>{t('detail')}</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.name}>
                  <td>{check.name}</td>
                  <td>
                    <StatusBadge value={check.status} />
                  </td>
                  <td>{check.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div></div>
  );
}

function statusClass(status: string): 'pass' | 'warn' | 'fail' {
  const normalized = status.toLowerCase();
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('down')) return 'fail';
  if (normalized.includes('warn') || normalized.includes('degrad')) return 'warn';
  return 'pass';
}

function ExtensionsSection() {
  const { t } = useI18n();
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .listExtensions()
      .then((result) => setExtensions(result.items))
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('installedExtensions')}</h3></div><div className="panel__body">
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {loading ? (
        <Loading />
      ) : (
        <ul className="extension-list">
          {extensions.map((ext) => (
            <li key={ext.id} className="extension-card">
              <div className="extension-card__header">
                <strong>{ext.name}</strong>
                <span>
                  v{ext.version} ({t('platform')} {ext.platformVersion})
                </span>
              </div>
              <dl className="extension-card__body">
                <dt>{t('permissions')}</dt><dd>{ext.permissions.join('、') || t('none')}</dd><dt>{t('subscribedEvents')}</dt><dd>{ext.subscribedEvents.join('、') || t('none')}</dd><dt>{t('commands')}</dt><dd>{ext.commands.join('、') || t('none')}</dd><dt>{t('queries')}</dt><dd>{ext.queries.join('、') || t('none')}</dd><dt>{t('providers')}</dt><dd>{ext.providers.join('、') || t('none')}</dd><dt>{t('mcpTools')}</dt><dd>{ext.mcpTools.join('、') || t('none')}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div></div>
  );
}

function SalesSummarySection() {
  const { t, formatMoney } = useI18n();
  const [from, setFrom] = useState(toDateInput(new Date(Date.now() - 30 * DAY_MS)));
  const [to, setTo] = useState(toDateInput(new Date()));
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

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-card">
      <span className="summary-card__label">{label}</span>
      <span className="summary-card__value">{value}</span>
    </div>
  );
}
