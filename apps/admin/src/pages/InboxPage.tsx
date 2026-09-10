import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type InboxNotification } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { inboxKeys } from '../query';

/** 站內收件匣（B07 的 GET /api/v1/notifications 一直沒有前端呼叫端，B13 片5 補上）。 */
export function InboxPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [terminalError, setTerminalError] = useState<unknown>(null);
  const input = { limit: 50, offset: 0, unreadOnly };
  const inboxQuery = useQuery({ queryKey: inboxKeys.list(input), queryFn: ({ signal }) => api.listInbox(input, signal) });
  const markRead = useMutation({
    mutationFn: (id: string) => api.markInboxRead([id], crypto.randomUUID()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: inboxKeys.lists }),
    onError: (error: unknown) => setTerminalError(error),
  });

  // 標題與副標由外殼的 page-heading 提供，頁面自己不再印一次。
  return <section>
    {terminalError ? <ErrorBanner error={terminalError} onDismiss={() => setTerminalError(null)} /> : null}
    {inboxQuery.isError ? <ErrorBanner error={inboxQuery.error} onRetry={() => void inboxQuery.refetch()} /> : null}
    <div className="toolbar">
      <label><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} /> {t('unreadOnly')}</label>
    </div>
    {inboxQuery.isLoading ? <Loading /> : inboxQuery.isSuccess && inboxQuery.data.items.length === 0 ? <EmptyState icon="alert" title={t('noNotifications')} /> : inboxQuery.isSuccess ? <ul className="inbox-list">
      {inboxQuery.data.items.map((notification) => <InboxRow key={notification.id} notification={notification} disabled={inboxQuery.isFetching || markRead.isPending} onMarkRead={() => markRead.mutate(notification.id)} />)}
    </ul> : null}
  </section>;
}

function InboxRow({ notification, disabled, onMarkRead }: { notification: InboxNotification; disabled: boolean; onMarkRead: () => void }) {
  const { t, formatDateTime } = useI18n();
  // readAt 是 null 代表未讀；只有未讀的通知才需要標記已讀按鈕
  const unread = notification.readAt === null;
  return <li className={unread ? 'inbox-row inbox-row--unread' : 'inbox-row'}>
    <div className="inbox-row__title">{notification.title}</div>
    <p className="inbox-row__body">{notification.body}</p>
    <div className="inbox-row__meta">
      <span className="mono">{t('createdAt')}: {formatDateTime(notification.createdAt)}</span>
      <span className="col-actions">{unread ? <button type="button" className="button button--quiet" disabled={disabled} onClick={onMarkRead}><Icon name="check" /> {t('markRead')}</button> : null}</span>
    </div>
  </li>;
}
