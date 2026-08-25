import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useEscapeKey } from '../hooks/useEscapeKey';

/**
 * 收一段必填理由再送出的小對話框。
 * window.prompt 會凍結整個分頁、無法帶上下文、也無法在送出失敗時留在原地，
 * 拒絕退貨這種事後要查帳的動作不該靠它。
 */
export function ReasonDialog({
  title,
  description,
  confirmLabel,
  placeholder,
  danger,
  onClose,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  placeholder?: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEscapeKey(onClose);

  const submit = () => {
    setTouched(true);
    if (!reason.trim()) return;
    onConfirm(reason.trim());
  };

  return (
    <div className="payload-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="reason-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="reason-dialog-header">
          <h3>{title}</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="關閉">
            <Icon name="close" />
          </button>
        </header>

        <form
          className="reason-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {description ? <p className="reason-dialog-desc">{description}</p> : null}
          <textarea
            aria-label={title}
            autoFocus
            rows={4}
            value={reason}
            placeholder={placeholder}
            onChange={(event) => setReason(event.target.value)}
          />
          {touched && !reason.trim() ? <p className="danger-text"><Icon name="alert" /> 請填寫原因後再送出。</p> : null}

          <footer className="reason-dialog-footer">
            <button className="button" type="button" onClick={onClose}>取消</button>
            <button className={`button ${danger ? 'button--danger' : 'button--primary'}`} type="submit">
              {confirmLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
