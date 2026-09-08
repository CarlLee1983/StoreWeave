import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DeadJob } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { deadJobKeys, healthKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperationEntries, useAdminOperations } from '../admin-operations';

type DeadJobOperation = AdminOperation & { kind: 'retry'; jobId: string; preview: { type: string } };
const deadJobScope = (id: string) => `dead-job:${id}`;
const isDeadJobOperationEntry = (entry: AdminOperationEntry): entry is AdminOperationEntry<DeadJobOperation> => entry.operation.area === 'dead-job' && entry.operation.scope.startsWith('dead-job:') && 'kind' in entry.operation && entry.operation.kind === 'retry';

function useDeadJobCommand() {
  const store = useAdminOperations();
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationKey: ['dead-job', 'command'] as const, mutationFn: (operation: DeadJobOperation) => api.retryDeadJob(operation.jobId, operation.idempotencyKey) });
  return (operation: DeadJobOperation, recovery?: AdminOperationEntry<DeadJobOperation>) => executeAdminOperation(store, operation, mutation.mutateAsync, (_result, live) => {
    void queryClient.invalidateQueries({ queryKey: deadJobKeys.lists });
    void queryClient.invalidateQueries({ queryKey: healthKeys.dependencies });
    return undefined;
  }, recovery);
}

export function DlqPage() {
  const { t } = useI18n();
  const input = { limit: 50, offset: 0 };
  const jobsQuery = useQuery({ queryKey: deadJobKeys.list(input), queryFn: ({ signal }) => api.listDeadJobs(input, signal) });
  const entries = useAdminOperationEntries();
  const recoveries = entries.filter(isDeadJobOperationEntry);
  const [terminalError, setTerminalError] = useState<unknown>(null);

  return <section>
    {terminalError ? <ErrorBanner error={terminalError} onDismiss={() => setTerminalError(null)} /> : null}
    {recoveries.map((entry) => <DeadJobRecovery key={entry.operation.idempotencyKey} entry={entry} onTerminalError={setTerminalError} />)}
    {jobsQuery.isError ? <ErrorBanner error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} /> : null}
    {jobsQuery.isLoading ? <Loading /> : jobsQuery.isSuccess && jobsQuery.data.items.length === 0 ? <EmptyState icon="alert" title={t('noDeadJobs')} /> : jobsQuery.isSuccess ? <div className="table-wrap"><table className="data-table data-table--fixed observability-table">
      <thead><tr>
        <th style={{ width: '22%' }}>{t('jobType')}</th><th style={{ width: '18%' }} className="col-numeric">{t('attempts')} / {t('maxAttempts')}</th><th style={{ width: '16%' }}>{t('failedAt')}</th><th style={{ width: '32%' }}>{t('lastError')}</th><th style={{ width: '12%' }} className="col-actions">{t('actions')}</th>
      </tr></thead>
      <tbody>{jobsQuery.data.items.map((job) => <DeadJobRow key={job.id} job={job} disabled={jobsQuery.isFetching} onTerminalError={setTerminalError} />)}</tbody>
    </table></div> : null}
  </section>;
}

function DeadJobRow({ job, disabled, onTerminalError }: { job: DeadJob; disabled: boolean; onTerminalError: (error: unknown) => void }) {
  const { t, formatDateTime } = useI18n();
  const command = useDeadJobCommand();
  const entry = useAdminOperationEntries().filter(isDeadJobOperationEntry).find((candidate) => candidate.operation.scope === deadJobScope(job.id));
  const retry = async () => {
    const operation: DeadJobOperation = { area: 'dead-job', scope: deadJobScope(job.id), kind: 'retry', jobId: job.id, preview: { type: job.type }, idempotencyKey: crypto.randomUUID() };
    const result = await command(operation, entry?.phase === 'unknown' ? entry : undefined);
    if (result.state === 'rejected') onTerminalError(result.error);
  };
  return <tr>
    <td>{job.type}</td><td className="col-numeric">{job.attempts} / {job.maxAttempts}</td><td>{formatDateTime(job.failedAt)}</td>
    <td>{job.lastError ? <span className="cell-truncate" title={job.lastError}>{job.lastError}</span> : t('none')}</td>
    <td className="col-actions"><button className="button button--quiet" type="button" disabled={disabled || !!entry} onClick={() => void retry()}><Icon name="refresh" /> {entry?.phase === 'pending' ? t('resending') : t('resend')}</button></td>
  </tr>;
}

function DeadJobRecovery({ entry, onTerminalError }: { entry: AdminOperationEntry<DeadJobOperation>; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const command = useDeadJobCommand();
  const [submitting, setSubmitting] = useState(false);
  const retry = async () => { setSubmitting(true); const result = await command(entry.operation, entry); if (result.state === 'rejected') onTerminalError(result.error); setSubmitting(false); };
  return <section className="account-panel" aria-label={t('resend')}><div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('operationPending') : t('unknownError')}</strong>{entry.phase === 'unknown' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}</div><dl className="order-totals"><dt>{t('jobType')}</dt><dd>{entry.operation.preview.type}</dd></dl></section>;
}
