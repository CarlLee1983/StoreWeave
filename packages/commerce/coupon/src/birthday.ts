/**
 * 生日禮券的日期判斷。
 *
 * 切片邊界對齊 UTC（ADR 0016），但「生日當天」是店鋪時區的當天——
 * 台北時間的整個 8/22，在 UTC 是 8/21 16:00 到 8/22 16:00。因此這裡把時刻
 * 換算成店鋪時區的日曆日期，而不是直接用 UTC 的月日。
 */
export function storeDateParts(at: Date, timeZone: string): { year: string; monthDay: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const value = (type: string) => parts.find((p) => p.type === type)!.value;
  return { year: value('year'), monthDay: `${value('month')}-${value('day')}` };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 今天該發給哪些「月-日」的壽星。
 *
 * 二月二十九日出生的人在平年沒有生日。把他們併到三月一日——
 * 四年才收到一次禮券不是體貼，是漏掉。
 */
export function birthdayMonthDaysFor(at: Date, timeZone: string): string[] {
  const { year, monthDay } = storeDateParts(at, timeZone);
  if (monthDay === '03-01' && !isLeapYear(Number(year))) return ['03-01', '02-29'];
  return [monthDay];
}
