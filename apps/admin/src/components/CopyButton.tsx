import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export function CopyButton({ text, label }: { text: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? 'copy-btn--copied' : ''}`}
      onClick={handleCopy}
      title={copied ? '已複製！' : `複製 ${label ?? text}`}
      aria-label={copied ? '已複製！' : `複製 ${label ?? text}`}
    >
      <Icon name={copied ? 'check' : 'copy'} />
      {copied ? <span className="copy-btn__tip">已複製</span> : null}
    </button>
  );
}
