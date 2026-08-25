import { useEffect, useState } from 'react';
import { api, type ExtensionInfo, type HealthReport } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';

export function SystemPage() {
  return (
    <section>
      <HealthSection />
      <ExtensionsSection />
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
          <table className="data-table data-table--fixed">
            <thead>
              <tr>
                <th style={{ width: '22%' }}>{t('name')}</th>
                <th style={{ width: '18%' }}>{t('status')}</th>
                <th style={{ width: '60%' }}>{t('detail')}</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.name}>
                  <td>{check.name}</td>
                  <td>
                    <StatusBadge value={check.status} />
                  </td>
                  <td>{check.detail ? <span className="cell-truncate" title={check.detail}>{check.detail}</span> : '—'}</td>
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
