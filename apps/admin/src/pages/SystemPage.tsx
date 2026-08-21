import { useEffect, useState } from 'react';
import { api, formatMoney, type ExtensionInfo, type HealthReport, type SalesSummary } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function SystemPage() {
  return (
    <section>
      <h2>系統狀態</h2>
      <HealthSection />
      <ExtensionsSection />
      <SalesSummarySection />
    </section>
  );
}

function HealthSection() {
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
      <h3>依賴健康檢查</h3>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {loading ? (
        <Loading />
      ) : (
        report && (
          <table className="data-table">
            <thead>
              <tr>
                <th>名稱</th>
                <th>狀態</th>
                <th>詳情</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.name}>
                  <td>{check.name}</td>
                  <td>
                    <span className={`status-pill status-pill--${statusClass(check.status)}`}>{check.status}</span>
                  </td>
                  <td>{check.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}

function statusClass(status: string): 'pass' | 'warn' | 'fail' {
  const normalized = status.toLowerCase();
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('down')) return 'fail';
  if (normalized.includes('warn') || normalized.includes('degrad')) return 'warn';
  return 'pass';
}

function ExtensionsSection() {
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
      <h3>已安裝擴充套件</h3>
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
                  v{ext.version}（平台 {ext.platformVersion}）
                </span>
              </div>
              <dl className="extension-card__body">
                <dt>權限</dt>
                <dd>{ext.permissions.join('、') || '無'}</dd>
                <dt>訂閱事件</dt>
                <dd>{ext.subscribedEvents.join('、') || '無'}</dd>
                <dt>指令</dt>
                <dd>{ext.commands.join('、') || '無'}</dd>
                <dt>查詢</dt>
                <dd>{ext.queries.join('、') || '無'}</dd>
                <dt>Providers</dt>
                <dd>{ext.providers.join('、') || '無'}</dd>
                <dt>MCP 工具</dt>
                <dd>{ext.mcpTools.join('、') || '無'}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SalesSummarySection() {
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
      <h3>銷售摘要</h3>
      <div className="toolbar">
        <label>
          從
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          到
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
              <SummaryCard label="已付款訂單" value={String(summary.paidOrderCount)} />
              <SummaryCard label="待付款訂單" value={String(summary.pendingOrderCount)} />
              <SummaryCard label="已取消訂單" value={String(summary.cancelledOrderCount)} />
              <SummaryCard label="總營收" value={formatMoney(summary.grossRevenueCents, summary.currency)} />
              <SummaryCard label="平均客單價" value={formatMoney(summary.averageOrderValueCents, summary.currency)} />
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>商品名稱</th>
                  <th>銷售數量</th>
                  <th>營收</th>
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
    </div>
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
