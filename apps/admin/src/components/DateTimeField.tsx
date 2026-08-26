import { DateField } from './DateField';

/**
 * `datetime-local` 的值（`YYYY-MM-DDTHH:mm`）拆成日期與時間兩個欄位：
 * 日期走 DateField 的日曆，時間留給原生 time input——它在深色下的指示器
 * 已經另外處理過，而且時間本來就打字比較快。
 */
export function DateTimeField({
  label,
  value,
  onChange,
  id,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  id?: string;
  hint?: string;
}) {
  const [datePart = '', timePart = ''] = value ? value.split('T') : [];

  const emit = (nextDate: string, nextTime: string) => {
    if (!nextDate) return onChange('');
    // 只選了日期就補 00:00，否則送出的值不是合法的 datetime-local。
    onChange(`${nextDate}T${nextTime || '00:00'}`);
  };

  return (
    <div className="datetime-field">
      <DateField
        id={id}
        label={label}
        value={datePart}
        hint={hint}
        onChange={(next) => emit(next, timePart)}
      />
      <label className="datetime-field__time">
        <span className="field-label-text">時間</span>
        <input
          type="time"
          aria-label={`${label} 時間`}
          value={timePart}
          onChange={(event) => emit(datePart, event.target.value)}
        />
      </label>
    </div>
  );
}
