import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { extensionKeys, healthKeys } from '../query';

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
  const query = useQuery({ queryKey: healthKeys.dependencies, queryFn: ({ signal }) => api.healthDependencies(signal) });
  const report = query.data;

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('dependencyHealth')}</h3></div><div className="panel__body">
      {query.isError ? <ErrorBanner error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isLoading ? (
        <Loading />
      ) : (
        report && (report.checks.length === 0 ? <EmptyState icon="activity" title={t('noHealthChecks')} /> : (
          <div className="table-wrap"><table className="data-table data-table--fixed observability-table">
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
                  <td>{check.detail ? <span className="cell-truncate" title={check.detail}>{check.detail}</span> : t('none')}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))
      )}
    </div></div>
  );
}

function ExtensionsSection() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: extensionKeys.list, queryFn: ({ signal }) => api.listExtensions(signal) });
  const extensions = query.data?.items;

  return (
    <div className="panel">
      <div className="panel__header"><h3>{t('installedExtensions')}</h3></div><div className="panel__body">
      {query.isError ? <ErrorBanner error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.isLoading ? (
        <Loading />
      ) : (
        extensions?.length === 0 ? <EmptyState icon="box" title={t('noExtensions')} /> : extensions ? <ul className="extension-list">
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
        </ul> : null
      )}
    </div></div>
  );
}
