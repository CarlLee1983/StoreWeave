import { useState, type ReactNode } from 'react';
import { DayPicker } from 'react-day-picker';
import { zhTW, enUS, ja } from 'react-day-picker/locale';
import { Icon } from './Icon';
import { useI18n } from '../i18n';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

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
/**
 * min/max 只約束日曆可選的範圍，不寫進原生 input 的 min/max：
 * 那會讓瀏覽器在提交時靜默擋下表單，跳出一顆英文的原生氣泡，
 * 使用者看不到我們自己那句說明是哪個欄位錯。越界值一律由送出前的檢查處理。
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

  const selected = toDate(value);
  // 還沒選日期時，從界線那個月開始顯示：不然打開結束日曆看到的整頁都是不能選的日子。
  const defaultMonth = selected ?? toDate(min ?? '') ?? toDate(max ?? '');

  return (
    <div className="date-field">
      <label htmlFor={id}>
        <span className="field-label-text">{label}</span>
      </label>
      <div className="date-field__control">
        <input
          id={id}
          type="date"
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="button button--quiet date-field__trigger"
              aria-label={`${label}：選擇日期`}
              disabled={disabled}
            >
              <Icon name="calendar" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="date-field__popup" align="start" aria-label={`${label}：選擇日期`}>
            <DayPicker
              mode="single"
              locale={LOCALES[locale] ?? zhTW}
              selected={selected}
              defaultMonth={defaultMonth}
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
          </PopoverContent>
        </Popover>
      </div>
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}
