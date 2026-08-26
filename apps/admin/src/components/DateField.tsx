import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DayPicker } from 'react-day-picker';
import { zhTW, enUS, ja } from 'react-day-picker/locale';
import { Icon } from './Icon';
import { useI18n } from '../i18n';
import { useEscapeKey } from '../hooks/useEscapeKey';

const LOCALES = { 'zh-TW': zhTW, 'en-US': enUS, 'ja-JP': ja } as const;

/** `YYYY-MM-DD` ⇄ Date。日曆給的是本地時區的日，不經過 UTC 換算以免整天位移。 */
function toDate(value: string): Date | undefined {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toISODate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 日期欄位：原生 <input type="date"> 在深色主題下的日曆圖示是深色的，
 * 幾乎看不見，操作者會以為根本沒有選擇器。這裡保留可直接打字的輸入框，
 * 另外掛一顆看得見的按鈕開 react-day-picker 的日曆。
 */
export function DateField({
  label,
  value,
  onChange,
  id,
  max,
  min,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  id?: string;
  max?: string;
  min?: string;
  disabled?: boolean;
  hint?: string;
}): ReactNode {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEscapeKey(() => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const selected = toDate(value);

  return (
    <div className="date-field" ref={wrapRef}>
      <label htmlFor={id}>
        <span className="field-label-text">{label}</span>
      </label>
      <div className="date-field__control">
        <input
          id={id}
          type="date"
          aria-label={label}
          value={value}
          max={max}
          min={min}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="button button--quiet date-field__trigger"
          aria-label={`${label}：選擇日期`}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="calendar" />
        </button>
      </div>
      {hint ? <p className="field-hint">{hint}</p> : null}
      {open ? (
        <div className="date-field__popup" role="dialog" aria-label={`${label}：選擇日期`}>
          <DayPicker
            mode="single"
            locale={LOCALES[locale] ?? zhTW}
            selected={selected}
            defaultMonth={selected}
            disabled={[
              ...(min ? [{ before: toDate(min)! }] : []),
              ...(max ? [{ after: toDate(max)! }] : []),
            ]}
            onSelect={(date) => {
              if (!date) return;
              onChange(toISODate(date));
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
