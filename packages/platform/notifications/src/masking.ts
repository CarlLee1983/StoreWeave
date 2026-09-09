/**
 * `a***@example.com`。留得下網域是為了看得出退信是不是集中在某一家。
 *
 * 星號數量固定，不跟著本地端長度走——長度本身就是線索，配上網域往往足以把人縮到幾個。
 * 單字元本地端整個遮掉：只有一個字元時，留下首字等於沒有遮。
 */
const MASK = '***';

export function maskRecipient(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return MASK;
  const local = [...email.slice(0, at)];
  const domain = email.slice(at + 1);
  if (local.length <= 1) return `${MASK}@${domain}`;
  return `${local[0]}${MASK}@${domain}`;
}

/** 投遞失敗訊息慣例會夾帶完整地址，隔壁欄位遮了這裡不遮等於沒遮。 */
export function maskEmailsIn(message: string | null): string | null {
  return message === null ? null : message.replace(/[^\s<>@]+@[^\s<>@,;]+/g, (match) => maskRecipient(match));
}
