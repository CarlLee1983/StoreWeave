import { ApiError } from '../api';
import { useI18n } from '../i18n';

/** 顯示錯誤的橫幅，包含 error code 與 message */
export function ErrorBanner({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  const { t } = useI18n();
  const { code, message } = describeError(error, t('unknownError'), t('clientError'));

  return (
    <div className="error-banner" role="alert">
      <strong>{code}</strong>
      <span>{message}</span>
      {onDismiss && (
        <button type="button" className="error-banner__close" onClick={onDismiss} aria-label={t('dismissError')}>
          ×
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
