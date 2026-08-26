import { useEffect, useState } from 'react';
import { api, type DeadJob } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { Icon } from '../components/Icon';

export function DlqPage({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<DeadJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listDeadJobs({ limit: 50 })
      .then((result) => !cancelled && setJobs(result.items))
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = () => {
    setReloadKey((k) => k + 1);
    onChanged();
  };

  return (
    <section>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}

      {loading ? (
        <Loading />
      ) : jobs.length === 0 ? (
        <p className="loading">{t('noDeadJobs')}</p>
      ) : (
        <div className="table-wrap"><table className="data-table data-table--fixed">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>{t('jobType')}</th>
              <th style={{ width: '18%' }} className="col-numeric">{t('attempts')} / {t('maxAttempts')}</th>
              <th style={{ width: '16%' }}>{t('failedAt')}</th>
              <th style={{ width: '32%' }}>{t('lastError')}</th>
              <th style={{ width: '12%' }} className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <DeadJobRow key={job.id} job={job} onResent={reload} />
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function DeadJobRow({ job, onResent }: { job: DeadJob; onResent: () => void }) {
  const { t, formatDateTime } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleRetry = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.retryDeadJob(job.id);
      onResent();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <tr>
      <td>{job.type}</td>
      <td className="col-numeric">{job.attempts} / {job.maxAttempts}</td>
      <td>{formatDateTime(job.failedAt)}</td>
      <td>
        {job.lastError ? <span className="cell-truncate" title={job.lastError}>{job.lastError}</span> : '—'}
      </td>
      <td className="col-actions">
        <button className="button button--quiet" type="button" disabled={submitting} onClick={handleRetry}>
          <Icon name="refresh" /> {submitting ? t('resending') : t('resend')}
        </button>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}
