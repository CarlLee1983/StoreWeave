import { useEffect, useState } from 'react';
import { api, type DeadJob } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';

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
        <div className="table-wrap"><table className="data-table">
          <thead>
            <tr>
              <th>{t('jobType')}</th><th>{t('attempts')} / {t('maxAttempts')}</th><th>{t('failedAt')}</th><th>{t('lastError')}</th>
              <th />
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
      <td className="mono">{job.attempts} / {job.maxAttempts}</td>
      <td>{formatDateTime(job.failedAt)}</td>
      <td>{job.lastError ?? '—'}</td>
      <td>
        <button className="button" type="button" disabled={submitting} onClick={handleRetry}>
          {submitting ? t('resending') : t('resend')}
        </button>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      </td>
    </tr>
  );
}
