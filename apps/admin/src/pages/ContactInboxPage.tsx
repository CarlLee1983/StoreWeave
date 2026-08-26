import { useEffect, useState } from 'react';
import { api, type ContactMessage } from '../api';
import { useI18n } from '../i18n';
import { ErrorBanner } from '../components/ErrorBanner';
import { Loading } from '../components/Loading';
import { StatusBadge } from '../components/StatusBadge';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';

export function ContactInboxPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const limit = 100;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .listContactMessages({ status: (status || undefined) as ContactMessage['status'] | undefined, limit })
      .then((result) => {
        if (cancelled) return;
        setMessages(result.items);
        setTotal(result.total);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [status, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <section>
      {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      {actionError ? <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} /> : null}

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('allStatuses')}</option>
          <option value="new">{t('messageNew')}</option>
          <option value="handled">{t('messageHandled')}</option>
        </select>
        {total > messages.length ? <span>{`${messages.length} / ${total}`}</span> : null}
      </div>

      {loading ? (
        <Loading />
      ) : messages.length === 0 ? (
        <EmptyState icon="send" title={t('noContactMessages')} hint="顧客從前台送出的訊息會出現在這裡。" />
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table--fixed">
            <thead>
              <tr>
                <th style={{ width: '18%' }}>{t('name')}</th>
                <th style={{ width: '22%' }}>{t('email')}</th>
                <th style={{ width: '24%' }}>{t('subject')}</th>
                <th style={{ width: '18%' }}>{t('submittedAt')}</th>
                <th style={{ width: '10%' }}>{t('status')}</th>
                <th style={{ width: '8%' }} className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  onChanged={reload}
                  onError={setActionError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MessageRow({
  message,
  onChanged,
  onError,
}: {
  message: ContactMessage;
  onChanged: () => void;
  onError: (error: unknown) => void;
}) {
  const { t, formatDateTime } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const markHandled = async () => {
    setSubmitting(true);
    onError(null);
    try {
      await api.markContactMessageHandled(message.id);
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <tr className="clickable" onClick={() => setExpanded((v) => !v)}>
        <td>{message.name}</td>
        <td><span className="cell-truncate" title={message.email}>{message.email}</span></td>
        <td><span className="cell-truncate" title={message.subject}>{message.subject}</span></td>
        <td className="mono">{formatDateTime(message.createdAt)}</td>
        <td>
          <StatusBadge
            value={message.status}
            label={message.status === 'new' ? t('messageNew') : t('messageHandled')}
          />
        </td>
        <td className="col-actions">
          {message.status === 'new' ? (
            <button
              type="button"
              className="button button--quiet"
              disabled={submitting}
              onClick={(e) => {
                e.stopPropagation();
                void markHandled();
              }}
            >
              <Icon name="check" /> {t('markHandled')}
            </button>
          ) : null}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <div className="order-detail">
              <div className="detail-cards">
                <section className="detail-card detail-card--wide">
                  <div className="detail-card__header"><h4>{t('message')}</h4></div>
                  <p className="message-body">{message.message}</p>
                  <dl className="order-totals">
                    <dt>{t('submittedAt')}</dt><dd className="mono">{formatDateTime(message.createdAt)}</dd>
                    <dt>{t('handledAt')}</dt><dd className="mono">{message.handledAt ? formatDateTime(message.handledAt) : '—'}</dd>
                  </dl>
                </section>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
