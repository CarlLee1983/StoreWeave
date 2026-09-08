import { ApiError } from '../api';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

/** 顯示錯誤的橫幅，包含 error code 與 message */
export function ErrorBanner({ error, onDismiss, onRetry }: { error: unknown; onDismiss?: () => void; onRetry?: () => void }) {
  const { t } = useI18n();
  const { code, message } = describeError(error, t('unknownError'), t('clientError'));

  return (
    <div className="error-banner" role="alert">
      <strong>{code}</strong>
      <span>{message}</span>
      {onRetry ? <button type="button" className="button button--quiet" onClick={onRetry}>{t('retryRead')}</button> : null}
      {onDismiss && (
        <button type="button" className="error-banner__close" onClick={onDismiss} aria-label={t('dismissError')}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

function describeError(error: unknown, unknownError: string, clientError: string): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'CLIENT_ERROR', message: error.message || clientError };
  }
  return { code: 'UNKNOWN_ERROR', message: unknownError };
}
