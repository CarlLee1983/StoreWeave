import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ErrorBanner } from './ErrorBanner';
import { Icon } from './Icon';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

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
  error,
  onDismissError,
  labels = { close: '關閉', cancel: '取消', invalidReason: '請填寫原因後再送出。', submitting: '送出中…' },
  initialReason = '',
  readOnly = false,
  recoveryAction,
  recoveryFocusRef,
  recoveryReady = false,
  returnFocus,
  onClose,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  placeholder?: string;
  danger?: boolean;
  error?: unknown;
  onDismissError?: () => void;
  labels?: { close: string; cancel: string; invalidReason: string; submitting: string };
  initialReason?: string;
  readOnly?: boolean;
  recoveryAction?: ReactNode;
  recoveryFocusRef?: RefObject<HTMLButtonElement | null>;
  recoveryReady?: boolean;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}): ReactNode {
  const [reason, setReason] = useState(initialReason);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useLayoutEffect(() => {
    if (recoveryReady) recoveryFocusRef?.current?.focus();
    else if (readOnly) cancelRef.current?.focus();
  }, [readOnly, recoveryFocusRef, recoveryReady]);

  const submit = async () => {
    setTouched(true);
    if (readOnly || !reason.trim()) return;
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open && !submitting) onClose(); }}>
      <DialogContent
        className="ui-reason-dialog"
        onOpenAutoFocus={(event: Event) => {
          event.preventDefault();
          (readOnly ? recoveryFocusRef?.current ?? cancelRef.current : textareaRef.current)?.focus();
        }}
        onCloseAutoFocus={(event: Event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <header className="ui-reason-dialog__header">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose type="button" className="icon-button" aria-label={labels.close} disabled={submitting}>
            <Icon name="close" />
          </DialogClose>
        </header>

        <form
          className="ui-reason-dialog__body"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {description ? <DialogDescription className="ui-reason-dialog__description">{description}</DialogDescription> : null}
          {error ? <ErrorBanner error={error} onDismiss={onDismissError} /> : null}
          <textarea
            aria-label={title}
            ref={textareaRef}
            rows={4}
            value={reason}
            placeholder={placeholder}
            readOnly={readOnly}
            onChange={(event) => setReason(event.target.value)}
          />
          {touched && !reason.trim() ? <p className="danger-text"><Icon name="alert" /> {labels.invalidReason}</p> : null}

          <footer className="ui-reason-dialog__footer">
            <DialogClose ref={cancelRef} className="button" type="button" disabled={submitting}>{labels.cancel}</DialogClose>
            {recoveryAction}
            <button className={`button ${danger ? 'button--danger' : 'button--primary'}`} type="submit" disabled={submitting || readOnly}>
              {submitting ? labels.submitting : confirmLabel}
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
