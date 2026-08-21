import { ApiError } from '../api';

/** 顯示錯誤的橫幅，包含 error code 與 message */
export function ErrorBanner({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  const { code, message } = describeError(error);

  return (
    <div className="error-banner" role="alert">
      <strong>{code}</strong>
      <span>{message}</span>
      {onDismiss && (
        <button type="button" className="error-banner__close" onClick={onDismiss} aria-label="關閉錯誤訊息">
          ×
        </button>
      )}
    </div>
  );
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'CLIENT_ERROR', message: error.message };
  }
  return { code: 'UNKNOWN_ERROR', message: '發生未知錯誤' };
}
