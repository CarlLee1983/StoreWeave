import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ContactMessage } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { contactMessageKeys } from '../query';
import { executeAdminOperation, type AdminOperation, type AdminOperationEntry, useAdminOperationEntries, useAdminOperations } from '../admin-operations';

type ContactOperation = AdminOperation & { kind: 'mark-handled'; messageId: string; preview: { name: string; subject: string } };
const contactScope = (id: string) => `contact-message:${id}`;
const isContactOperationEntry = (entry: AdminOperationEntry): entry is AdminOperationEntry<ContactOperation> => entry.operation.area === 'contact-message' && entry.operation.scope.startsWith('contact-message:') && 'kind' in entry.operation && entry.operation.kind === 'mark-handled';

function useContactCommand() {
  const store = useAdminOperations();
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationKey: ['contact-message', 'command'] as const, mutationFn: (operation: ContactOperation) => api.markContactMessageHandled(operation.messageId, operation.idempotencyKey) });
  return (operation: ContactOperation, recovery?: AdminOperationEntry<ContactOperation>) => executeAdminOperation(store, operation, mutation.mutateAsync, () => {
    void queryClient.invalidateQueries({ queryKey: contactMessageKeys.lists });
    return undefined;
  }, recovery);
}

export function ContactInboxPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ContactMessage['status'] | ''>('');
  const [terminalError, setTerminalError] = useState<unknown>(null);
  const input = { ...(status === '' ? {} : { status }), limit: 100, offset: 0 };
  const messagesQuery = useQuery({ queryKey: contactMessageKeys.list(input), queryFn: ({ signal }) => api.listContactMessages(input, signal) });
  const recoveries = useAdminOperationEntries().filter(isContactOperationEntry);

  return <section>
    {terminalError ? <ErrorBanner error={terminalError} onDismiss={() => setTerminalError(null)} /> : null}
    {recoveries.map((entry) => <ContactRecovery key={entry.operation.idempotencyKey} entry={entry} onTerminalError={setTerminalError} />)}
    {messagesQuery.isError ? <ErrorBanner error={messagesQuery.error} onRetry={() => void messagesQuery.refetch()} /> : null}
    <div className="toolbar">
      <select value={status} onChange={(event) => setStatus(event.target.value as ContactMessage['status'] | '')} aria-label={t('status')}>
        <option value="">{t('allStatuses')}</option><option value="new">{t('messageNew')}</option><option value="handled">{t('messageHandled')}</option>
      </select>
      {messagesQuery.isSuccess && messagesQuery.data.total > messagesQuery.data.items.length ? <span>{`${messagesQuery.data.items.length} / ${messagesQuery.data.total}`}</span> : null}
    </div>
    {messagesQuery.isLoading ? <Loading /> : messagesQuery.isSuccess && messagesQuery.data.items.length === 0 ? <EmptyState icon="send" title={t('noContactMessages')} hint={t('contactInboxEmptyHint')} /> : messagesQuery.isSuccess ? <div className="table-wrap"><table className="data-table data-table--fixed observability-table">
      <thead><tr><th style={{ width: '18%' }}>{t('name')}</th><th style={{ width: '22%' }}>{t('email')}</th><th style={{ width: '24%' }}>{t('subject')}</th><th style={{ width: '18%' }}>{t('submittedAt')}</th><th style={{ width: '10%' }}>{t('status')}</th><th style={{ width: '8%' }} className="col-actions">{t('actions')}</th></tr></thead>
      <tbody>{messagesQuery.data.items.map((message) => <MessageRow key={message.id} message={message} blocked={messagesQuery.isFetching} onTerminalError={setTerminalError} />)}</tbody>
    </table></div> : null}
  </section>;
}

function MessageRow({ message, blocked, onTerminalError }: { message: ContactMessage; blocked: boolean; onTerminalError: (error: unknown) => void }) {
  const { t, formatDateTime } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const command = useContactCommand();
  const entry = useAdminOperationEntries().filter(isContactOperationEntry).find((candidate) => candidate.operation.scope === contactScope(message.id));
  const markHandled = async () => {
    const operation: ContactOperation = { area: 'contact-message', scope: contactScope(message.id), kind: 'mark-handled', messageId: message.id, preview: { name: message.name, subject: message.subject }, idempotencyKey: crypto.randomUUID() };
    const result = await command(operation, entry?.phase === 'unknown' ? entry : undefined);
    if (result.state === 'rejected') onTerminalError(result.error);
  };
  return <>
    <tr className="clickable" onClick={() => setExpanded((value) => !value)}>
      <td>{message.name}</td><td><span className="cell-truncate" title={message.email}>{message.email}</span></td><td><span className="cell-truncate" title={message.subject}>{message.subject}</span></td><td className="mono">{formatDateTime(message.createdAt)}</td>
      <td><StatusBadge value={message.status} label={message.status === 'new' ? t('messageNew') : t('messageHandled')} /></td>
      <td className="col-actions">{message.status === 'new' ? <button type="button" className="button button--quiet" disabled={blocked || !!entry} onClick={(event) => { event.stopPropagation(); void markHandled(); }}><Icon name="check" /> {t('markHandled')}</button> : null}</td>
    </tr>
    {expanded ? <tr><td colSpan={6}><div className="order-detail"><div className="detail-cards"><section className="detail-card detail-card--wide"><div className="detail-card__header"><h4>{t('message')}</h4></div><p className="message-body">{message.message}</p><dl className="order-totals"><dt>{t('submittedAt')}</dt><dd className="mono">{formatDateTime(message.createdAt)}</dd><dt>{t('handledAt')}</dt><dd className="mono">{message.handledAt ? formatDateTime(message.handledAt) : t('none')}</dd></dl></section></div></div></td></tr> : null}
  </>;
}

function ContactRecovery({ entry, onTerminalError }: { entry: AdminOperationEntry<ContactOperation>; onTerminalError: (error: unknown) => void }) {
  const { t } = useI18n();
  const command = useContactCommand();
  const [submitting, setSubmitting] = useState(false);
  const retry = async () => { setSubmitting(true); const result = await command(entry.operation, entry); if (result.state === 'rejected') onTerminalError(result.error); setSubmitting(false); };
  return <section className="account-panel" aria-label={t('markHandled')}><div className="error-banner" role="status"><strong>{entry.phase === 'pending' ? t('operationPending') : t('unknownError')}</strong>{entry.phase === 'unknown' ? <button className="button button--quiet" type="button" disabled={submitting} onClick={() => void retry()}>{t('retryOriginalOperation')}</button> : null}</div><dl className="order-totals"><dt>{t('name')}</dt><dd>{entry.operation.preview.name}</dd><dt>{t('subject')}</dt><dd>{entry.operation.preview.subject}</dd></dl></section>;
}
