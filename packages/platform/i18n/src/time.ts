export interface TimeFormatOptions {
  readonly locale: string;
  /** IANA 時區名稱，來自 `store.timezone`。顯示一律用它，不用主機時區。 */
  readonly timeZone: string;
}

function instantOf(value: Date | string | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Expected a valid date');
  }
  return date;
}

/**
 * 送進 API 與資料庫的唯一日期寫法：UTC 的 ISO 8601。
 *
 * 用函式而不是各處直接 `toISOString()`，是為了讓「無效日期」在序列化時就失敗，
 * 而不是把 `Invalid Date` 寫進 payload 再由下游猜。
 */
export function toIsoString(value: Date | string | number): string {
  return instantOf(value).toISOString();
}

function format(value: Date | string | number, options: TimeFormatOptions, style: Intl.DateTimeFormatOptions): string {
  const instant = instantOf(value);
  try {
    return new Intl.DateTimeFormat(options.locale, { ...style, timeZone: options.timeZone }).format(instant);
  } catch {
    // 時區或語系標籤不被支援時，寧可顯示明確的 UTC ISO，也不要顯示錯的當地時間。
    return instant.toISOString();
  }
}

/** 日期加時間。清單以外的地方用這個。 */
export function formatDateTime(value: Date | string | number, options: TimeFormatOptions): string {
  return format(value, options, { dateStyle: 'short', timeStyle: 'short' });
}

/** 只給日期：短欄寬放不下時間，會折成兩行把整列撐高。 */
export function formatDate(value: Date | string | number, options: TimeFormatOptions): string {
  return format(value, options, { dateStyle: 'short' });
}
